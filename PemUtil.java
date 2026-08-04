package com.zatca.signing;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * The ZATCA SDK's InvoiceSigningService rejects PEM-formatted cert/key files
 * outright — confirmed empirically against the real jar:
 *   "please provide private key without -----BEGIN EC PRIVATE KEY----- ..."
 *   "please provide certificate decoded base64"
 * It wants the raw base64 body only, no headers, no line breaks.
 */
final class PemUtil {

    private PemUtil() {}

    static String stripPemToSingleLine(Path pemPath) throws IOException {
        String content = Files.readString(pemPath);
        StringBuilder out = new StringBuilder();
        for (String line : content.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("-----")) {
                continue;
            }
            out.append(trimmed);
        }
        return out.toString();
    }
}
