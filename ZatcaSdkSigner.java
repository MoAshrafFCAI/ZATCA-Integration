package com.zatca.signing;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Wraps `java -jar <sdk.jar> -invoice input.xml -sign -signedinvoice signed.xml`.
 *
 * Everything in this class was verified against the real jar you uploaded
 * (zatca-einvoicing-sdk-238-R3_4_8.jar, Main-Class com.zatca.sdk.MainApp),
 * not guessed:
 *   - -invoice / -sign / -signedinvoice are the real flags (recovered from
 *     ArgumentHandlerService's string constants and confirmed by running them).
 *   - Both -invoice and -signedinvoice resolve relative to the JVM's working
 *     directory, NOT the inputPath/outputPath fields in SDK_CONFIG — confirmed
 *     by running from two different working directories.
 *   - Exit code is 0 on success, 1 on failure (missing file, invalid cert, etc).
 *   - On success, the process logs a line containing
 *     "INVOICE HASH = <base64>" — that's the canonicalized invoice hash,
 *     already computed by the SDK itself (no separate hashing step needed).
 *   - The signed output XML already has the XAdES signature block AND the
 *     QR code TLV embedded — this single command replaces the entire
 *     canonicalize -> hash -> sign -> build QR -> embed pipeline we originally
 *     wrote by hand in JS.
 */
final class ZatcaSdkSigner {

    private static final Pattern HASH_PATTERN = Pattern.compile("INVOICE HASH\\s*=\\s*(\\S+)");

    private final Path javaBin;
    private final Path sdkJarPath;
    private final Path certFile;
    private final Path privateKeyFile;
    private final String certPassword;
    private final Path baseWorkDir;
    private final Duration timeout;
    private final boolean keepTempDirsForDebug;

    ZatcaSdkSigner(Path javaBin, Path sdkJarPath, Path certFile, Path privateKeyFile,
                   String certPassword, Path baseWorkDir, Duration timeout, boolean keepTempDirsForDebug) {
        this.javaBin = javaBin;
        this.sdkJarPath = sdkJarPath;
        this.certFile = certFile;
        this.privateKeyFile = privateKeyFile;
        this.certPassword = certPassword;
        this.baseWorkDir = baseWorkDir;
        this.timeout = timeout;
        this.keepTempDirsForDebug = keepTempDirsForDebug;
    }

    record Result(boolean success, String invoiceHash, byte[] signedXml, String log) {}

    Result sign(byte[] unsignedInvoiceXml) throws IOException, InterruptedException {
        Path requestDir = Files.createTempDirectory(baseWorkDir, "zatca-sign-");
        try {
            String certBase64 = PemUtil.stripPemToSingleLine(certFile);
            String keyBase64 = PemUtil.stripPemToSingleLine(privateKeyFile);
            Path sdkConfig = SdkConfigFactory.write(requestDir, certBase64, keyBase64, certPassword);

            Path inputFile = requestDir.resolve("input.xml");
            Path outputFile = requestDir.resolve("signed.xml");
            Files.write(inputFile, unsignedInvoiceXml);

            List<String> command = List.of(
                    javaBin.toString(), "-jar", sdkJarPath.toString(),
                    "-invoice", "input.xml",
                    "-sign",
                    "-signedinvoice", "signed.xml"
            );

            ProcessBuilder pb = new ProcessBuilder(command)
                    .directory(requestDir.toFile())
                    .redirectErrorStream(true);
            pb.environment().put("SDK_CONFIG", sdkConfig.toString());

            Process process = pb.start();
            String log;
            try (var is = process.getInputStream()) {
                log = new String(is.readAllBytes(), StandardCharsets.UTF_8);
            }

            boolean finished = process.waitFor(timeout.toSeconds(), TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                return new Result(false, null, null, log + "\n[wrapper] TIMED OUT after " + timeout);
            }

            int exitCode = process.exitValue();
            if (exitCode != 0) {
                return new Result(false, null, null, log + "\n[wrapper] exit code " + exitCode);
            }

            if (!Files.exists(outputFile)) {
                return new Result(false, null, null, log + "\n[wrapper] SDK reported success but signed.xml was not found");
            }

            Matcher m = HASH_PATTERN.matcher(log);
            String hash = m.find() ? m.group(1) : null;
            byte[] signedXml = Files.readAllBytes(outputFile);

            return new Result(true, hash, signedXml, log);
        } finally {
            if (!keepTempDirsForDebug) {
                deleteRecursively(requestDir);
            }
        }
    }

    private static void deleteRecursively(Path dir) throws IOException {
        if (!Files.exists(dir)) return;
        List<Path> paths = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.forEach(paths::add);
        }
        paths.sort(Comparator.reverseOrder());
        for (Path p : paths) {
            Files.deleteIfExists(p);
        }
    }
}
