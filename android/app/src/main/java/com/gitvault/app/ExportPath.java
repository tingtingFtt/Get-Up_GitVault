package com.gitvault.app;

final class ExportPath {
    static void validate(String path) {
        if (path == null || path.isEmpty() || path.startsWith("/") || path.contains("\\")) throw new IllegalArgumentException("文件路径不安全");
        for (String segment : path.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..")) throw new IllegalArgumentException("文件路径不安全");
            for (int i = 0; i < segment.length(); i++) if (segment.charAt(i) < 32) throw new IllegalArgumentException("文件路径不安全");
        }
    }
}
