package com.gitvault.app;

import org.junit.Test;
import static org.junit.Assert.fail;

public class ExportPathTest {
    @Test public void rejectsTraversalAndAbsolutePaths() {
        for (String path : new String[] { "", "/etc/config", "../secret", "a/../b", "a//b", "a/", "a\\b", "a/./b", "a/\u0000b" }) {
            try { ExportPath.validate(path); fail("Accepted unsafe path"); }
            catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void acceptsRepositoryFiles() { ExportPath.validate("owner/project/feature%2Fdemo/sha/files/中文 file.txt"); }
}
