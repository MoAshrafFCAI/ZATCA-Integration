package com.zatca.signing;

/**
 * Minimal hand-rolled JSON object builder — intentionally not a general
 * purpose library. We control every value going in here (booleans, base64
 * strings, plain ASCII messages), so a small escaper is enough and avoids
 * pulling in Jackson/Gson (no Maven Central access in this environment, and
 * no real need for a full library for a 3-field response object).
 */
final class JsonUtil {

    private JsonUtil() {}

    static String escape(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.toString();
    }

    static String field(String key, String value) {
        return "\"" + escape(key) + "\":\"" + escape(value) + "\"";
    }

    static String field(String key, boolean value) {
        return "\"" + escape(key) + "\":" + value;
    }
}
