package com.gitvault.app;

import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.*;

public class FolderPathLayoutTest {
    @Test public void caseCollisionsRemainDistinctAndRoundTripNestedPaths(){
        List<String> paths=Arrays.asList("资源/应用/Bubble/.author","资源/应用/bubble/.author","资源/应用/Bubble/说明.txt","资源/应用/bubble/说明.txt","src/a.txt");
        FolderPathLayout layout=FolderPathLayout.plan(paths);assertEquals(2,layout.aliases().size());Set<String> physical=new HashSet<>();for(String path:paths){assertTrue(physical.add(FolderPathLayout.folded(layout.physical(path))));assertEquals(path,layout.logical(layout.physical(path)));}assertEquals("src/a.txt",layout.physical("src/a.txt"));
        String mappedParent=layout.physical("资源/应用/Bubble");assertEquals("资源/应用/Bubble/new.txt",layout.logical(mappedParent+"/new.txt"));
        List<String> reversed=new ArrayList<>(paths);Collections.reverse(reversed);assertEquals(layout.aliases(),FolderPathLayout.plan(reversed).aliases());
    }
    @Test public void normalizationFileDirectoryAndAliasNameConflictsDoNotLoseOriginalNames(){
        List<String> paths=Arrays.asList("a","A/inside","é.txt","e\u0301.txt","READme.txt","readME.txt");FolderPathLayout first=FolderPathLayout.plan(paths);List<String> expanded=new ArrayList<>(paths);expanded.add(first.aliases().get("a"));FolderPathLayout layout=FolderPathLayout.plan(expanded);
        Set<String> physical=new HashSet<>();for(String path:expanded){assertTrue(physical.add(FolderPathLayout.folded(layout.physical(path))));assertEquals(path,layout.logical(layout.physical(path)));assertTrue(Normalizer.isNormalized(layout.physical(path),Normalizer.Form.NFC));}
    }
    @Test public void longUnicodeAliasesFitStorageNameLimits(){
        String base=String.join("",Collections.nCopies(70,"界"));FolderPathLayout layout=FolderPathLayout.plan(Arrays.asList(base+"A",base+"a"));for(String alias:layout.aliases().values())assertTrue(alias.getBytes(StandardCharsets.UTF_8).length<=255);
    }
    @Test public void rejectsUnsafeDuplicateAndConflictingGitPaths(){
        for(List<String> paths:Arrays.asList(Arrays.asList("../a"),Arrays.asList("a","a"),Arrays.asList("a/b","a"),Arrays.asList("a","a/b"))){try{FolderPathLayout.plan(paths);fail("Invalid path set accepted");}catch(IllegalArgumentException correct){}}
    }
}
