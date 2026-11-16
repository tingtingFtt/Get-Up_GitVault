package com.gitvault.buildtools;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.jar.*;
import org.objectweb.asm.*;
import org.objectweb.asm.commons.*;

/** Keep upstream JGit intact except for its assumption about borrowed inflater streams. */
public final class JgitAndroidJar {
    private static final String PLATFORM = "java/util/zip/InflaterInputStream";
    private static final String BORROWED = "com/gitvault/compat/BorrowedInflaterInputStream";

    public static void rewrite(File source, File destination) throws IOException {
        Files.createDirectories(destination.toPath().getParent());
        Set<String> changed = new TreeSet<>();
        try (JarFile input = new JarFile(source)) {
            Manifest manifest = input.getManifest();
            manifest = manifest == null ? new Manifest() : new Manifest(manifest);
            // Modified classes cannot retain upstream JAR signature digests.
            manifest.getEntries().clear();
            manifest.getMainAttributes().remove(new Attributes.Name("Signature-Version"));
            manifest.getMainAttributes().put(Attributes.Name.MANIFEST_VERSION, "1.0");
            try (JarOutputStream output = new JarOutputStream(new FileOutputStream(destination), manifest)) {
                for (Enumeration<JarEntry> entries = input.entries(); entries.hasMoreElements();) {
                    JarEntry entry = entries.nextElement();
                    String name = entry.getName();
                    if (name.equalsIgnoreCase("META-INF/MANIFEST.MF") ||
                            name.toUpperCase(Locale.ROOT).matches("META-INF/[^/]+\\.(SF|RSA|DSA|EC)")) continue;
                    byte[] bytes;
                    try (InputStream stream = input.getInputStream(entry)) { bytes = stream.readAllBytes(); }
                    if (name.endsWith(".class")) {
                        ClassReader reader = new ClassReader(bytes);
                        ClassWriter writer = new ClassWriter(0);
                        boolean[] modified = { false };
                        reader.accept(new ClassRemapper(writer, new Remapper() {
                            @Override public String map(String type) {
                                if (PLATFORM.equals(type)) { modified[0] = true; return BORROWED; }
                                return type;
                            }
                        }), 0);
                        if (modified[0]) { bytes = writer.toByteArray(); changed.add(name); }
                    }
                    JarEntry result = new JarEntry(name);
                    result.setTime(0);
                    output.putNextEntry(result); output.write(bytes); output.closeEntry();
                }
                // Fail closed if a dependency update changes the stream ownership sites.
                for (String required : new String[] {
                        "org/eclipse/jgit/internal/storage/file/LargePackedWholeObject.class",
                        "org/eclipse/jgit/internal/storage/file/UnpackedObject$1.class" }) {
                    if (!changed.contains(required)) throw new IOException("JGit inflater compatibility site missing: " + required);
                }
                output.putNextEntry(new JarEntry("META-INF/gitvault-android-inflater.txt"));
                output.write(String.join("\n", changed).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                output.closeEntry();
            }
        } catch (IOException | RuntimeException error) {
            Files.deleteIfExists(destination.toPath()); throw error;
        }
    }

    public static void main(String[] arguments) throws IOException {
        rewrite(new File(arguments[0]), new File(arguments[1]));
    }
}
