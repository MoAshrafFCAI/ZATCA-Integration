package com.zatca.signing;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Base64;
import java.util.concurrent.Executors;

/**
 * Internal signing microservice. Node (the Oracle Fusion / ZATCA orchestration
 * pipeline) calls this instead of doing canonicalization/hashing/signing/QR
 * generation itself — that work is now delegated to the real ZATCA SDK jar,
 * which is the actual reference implementation ZATCA validates against.
 *
 * Endpoints:
 *   GET  /health  -> "OK"
 *   POST /sign    -> body: raw unsigned UBL invoice XML (Content-Type: application/xml)
 *                    response: JSON { success, invoiceHash, signedInvoiceXml (base64) }
 *                    or on failure: { success: false, error }
 *
 * Required environment variables:
 *   ZATCA_SDK_JAR_PATH    - path to zatca-einvoicing-sdk-*.jar
 *   ZATCA_CERT_PATH       - PEM certificate file (PEM headers are fine, stripped internally)
 *   ZATCA_PRIVATE_KEY_PATH- PEM private key file (PEM headers are fine, stripped internally)
 * Optional:
 *   ZATCA_CERT_PASSWORD   - default ""
 *   ZATCA_JAVA_BIN        - java executable to run the SDK with (default: "java" on PATH).
 *                            NOTE: the SDK was built against JDK 11 (Build-Jdk-Spec: 11) for
 *                            secp256k1 compliance. It ran successfully under JDK 21 in testing
 *                            here, but pin a JDK 11-14 runtime for this if you want to match
 *                            ZATCA's documented supported range exactly rather than relying on
 *                            an unverified newer-JDK compatibility.
 *   ZATCA_SIGN_TIMEOUT_SECONDS - default 30
 *   ZATCA_KEEP_TEMP_DIRS  - "true" to keep per-request temp dirs for debugging (default false)
 *   PORT                  - default 8080
 */
public final class ZatcaSigningService {

    public static void main(String[] args) throws Exception {
        String sdkJarPath = requireEnv("ZATCA_SDK_JAR_PATH");
        String certPath = requireEnv("ZATCA_CERT_PATH");
        String privateKeyPath = requireEnv("ZATCA_PRIVATE_KEY_PATH");
        String certPassword = System.getenv().getOrDefault("ZATCA_CERT_PASSWORD", "");
        String javaBin = System.getenv().getOrDefault("ZATCA_JAVA_BIN", "java");
        long timeoutSeconds = Long.parseLong(System.getenv().getOrDefault("ZATCA_SIGN_TIMEOUT_SECONDS", "30"));
        boolean keepTempDirs = Boolean.parseBoolean(System.getenv().getOrDefault("ZATCA_KEEP_TEMP_DIRS", "false"));
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));

        Path sdkJar = Path.of(sdkJarPath);
        Path cert = Path.of(certPath);
        Path privateKey = Path.of(privateKeyPath);
        if (!Files.exists(sdkJar)) throw new IllegalStateException("ZATCA_SDK_JAR_PATH does not exist: " + sdkJar);
        if (!Files.exists(cert)) throw new IllegalStateException("ZATCA_CERT_PATH does not exist: " + cert);
        if (!Files.exists(privateKey)) throw new IllegalStateException("ZATCA_PRIVATE_KEY_PATH does not exist: " + privateKey);

        Path baseWorkDir = Files.createTempDirectory("zatca-signing-service-");

        ZatcaSdkSigner signer = new ZatcaSdkSigner(
                Path.of(javaBin), sdkJar, cert, privateKey, certPassword,
                baseWorkDir, Duration.ofSeconds(timeoutSeconds), keepTempDirs
        );

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.setExecutor(Executors.newFixedThreadPool(4));

        server.createContext("/health", exchange -> {
            byte[] body = "OK".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(body);
            }
        });

        server.createContext("/sign", exchange -> handleSign(exchange, signer));

        server.start();
        System.out.println("ZATCA signing service listening on :" + port);
        System.out.println("SDK jar: " + sdkJar);
        System.out.println("Work dir: " + baseWorkDir);
    }

    private static void handleSign(HttpExchange exchange, ZatcaSdkSigner signer) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            respondJson(exchange, 405, jsonError("Only POST is supported"));
            return;
        }

        byte[] requestBody;
        try (var is = exchange.getRequestBody()) {
            requestBody = is.readAllBytes();
        }

        if (requestBody.length == 0) {
            respondJson(exchange, 400, jsonError("Request body must contain the unsigned invoice XML"));
            return;
        }

        try {
            ZatcaSdkSigner.Result result = signer.sign(requestBody);
            if (!result.success()) {
                System.err.println("[sign] SDK failed:\n" + result.log());
                respondJson(exchange, 422, jsonError("ZATCA SDK failed to sign the invoice — see service logs for details"));
                return;
            }

            String signedXmlBase64 = Base64.getEncoder().encodeToString(result.signedXml());
            String json = "{" +
                    JsonUtil.field("success", true) + "," +
                    JsonUtil.field("invoiceHash", result.invoiceHash()) + "," +
                    JsonUtil.field("signedInvoiceXml", signedXmlBase64) +
                    "}";
            respondJson(exchange, 200, json);
        } catch (Exception e) {
            System.err.println("[sign] unexpected error: " + e);
            e.printStackTrace();
            respondJson(exchange, 500, jsonError("Unexpected error: " + e.getMessage()));
        }
    }

    private static String jsonError(String message) {
        return "{" + JsonUtil.field("success", false) + "," + JsonUtil.field("error", message) + "}";
    }

    private static void respondJson(HttpExchange exchange, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(body);
        }
    }

    private static String requireEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Missing required environment variable: " + name);
        }
        return value;
    }
}
