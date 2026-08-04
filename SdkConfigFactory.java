package com.zatca.signing;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Writes the JSON config file the SDK expects via the SDK_CONFIG env var.
 *
 * Field names were recovered by decompiling/inspecting the actual jar
 * (com.zatca.config.Config / ResourcesPaths), not from public docs — the
 * SDK ships with no CLI --help output describing this file. Confirmed
 * empirically: for the "-sign" command specifically, only certPath,
 * privateKeyPath, and certPassword are actually read; xsdPath, enSchematron,
 * zatcaSchematron, pihPath, inputPath, outputPath, usagePathFile can be
 * garbage/nonexistent paths and -sign still succeeds. They likely matter for
 * -validate / -csr / -apirequest, which this service doesn't call. If you
 * later add those endpoints, this file needs real values for those paths
 * (extractable from the jar's own bundled xsds/ and schematrons/ dirs).
 */
final class SdkConfigFactory {

    private SdkConfigFactory() {}

    static Path write(Path workDir, String certBase64, String privateKeyBase64, String certPassword) throws IOException {
        Path certFile = workDir.resolve("cert-raw.txt");
        Path keyFile = workDir.resolve("key-raw.txt");
        Files.writeString(certFile, certBase64);
        Files.writeString(keyFile, privateKeyBase64);

        String json = "{\n" +
                "  \"xsdPath\": \"unused-for-sign\",\n" +
                "  \"enSchematron\": \"unused-for-sign\",\n" +
                "  \"zatcaSchematron\": \"unused-for-sign\",\n" +
                "  \"certPath\": \"" + escape(certFile.toString()) + "\",\n" +
                "  \"pihPath\": \"unused-for-sign\",\n" +
                "  \"certPassword\": \"" + escape(certPassword) + "\",\n" +
                "  \"privateKeyPath\": \"" + escape(keyFile.toString()) + "\",\n" +
                "  \"inputPath\": \"unused-for-sign\",\n" +
                "  \"outputPath\": \"unused-for-sign\",\n" +
                "  \"usagePathFile\": \"unused-for-sign\"\n" +
                "}\n";

        Path configFile = workDir.resolve("sdk-config.json");
        Files.writeString(configFile, json);
        return configFile;
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
