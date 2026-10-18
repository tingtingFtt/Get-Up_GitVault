package com.gitvault.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.*;

/** Logical Git names remain exact. Only colliding on-disk siblings get aliases. */
final class FolderPathLayout {
    private final Map<String,String> aliases;
    private final Map<String,String> reverse=new HashMap<>();
    FolderPathLayout(Map<String,String> values) {
        aliases=Collections.unmodifiableMap(new LinkedHashMap<>(values));
        for(Map.Entry<String,String> entry:aliases.entrySet()){
            ExportPath.validate(entry.getKey());ExportPath.validate(entry.getValue());
            if(entry.getValue().contains("/"))throw new IllegalArgumentException("目录映射名称无效");
            if(reverse.put(physical(entry.getKey()),entry.getKey())!=null)throw new IllegalArgumentException("目录映射重复");
        }
    }
    Map<String,String> aliases(){return aliases;}
    static String folded(String name){return Normalizer.normalize(name,Normalizer.Form.NFC).toUpperCase(Locale.ROOT).toLowerCase(Locale.ROOT);}
    String physical(String logical){
        ExportPath.validate(logical);StringBuilder source=new StringBuilder(),target=new StringBuilder();
        for(String name:logical.split("/")){if(source.length()>0){source.append('/');target.append('/');}source.append(name);target.append(aliases.containsKey(source.toString())?aliases.get(source.toString()):name);}return target.toString();
    }
    String logical(String physical){
        ExportPath.validate(physical);StringBuilder prefix=new StringBuilder();String result="";
        for(String name:physical.split("/")){if(prefix.length()>0)prefix.append('/');prefix.append(name);String original=reverse.get(prefix.toString());result=original!=null?original:result.isEmpty()?name:result+"/"+name;}return result;
    }
    private static final class Node {boolean file;final Map<String,Node> children=new TreeMap<>();}
    static FolderPathLayout plan(Collection<String> paths){
        Node root=new Node();
        for(String path:paths){ExportPath.validate(path);Node node=root;for(String name:path.split("/")){if(node.file)throw new IllegalArgumentException("文件与目录路径冲突："+path);node=node.children.computeIfAbsent(name,key->new Node());}if(node.file||!node.children.isEmpty())throw new IllegalArgumentException("文件路径重复或与目录冲突："+path);node.file=true;}
        Map<String,String> result=new LinkedHashMap<>();planChildren(root,"",result);return new FolderPathLayout(result);
    }
    private static void planChildren(Node node,String parent,Map<String,String> result){
        Map<String,List<String>> groups=new TreeMap<>();Set<String> used=new HashSet<>();
        for(String name:node.children.keySet()){String key=folded(name);groups.computeIfAbsent(key,value->new ArrayList<>()).add(name);used.add(key);}
        for(List<String> names:groups.values())if(names.size()>1||names.stream().anyMatch(name->!Normalizer.isNormalized(name,Normalizer.Form.NFC)))for(String name:names){
            String path=parent.isEmpty()?name:parent+"/"+name,base=Normalizer.normalize(name,Normalizer.Form.NFC);
            while(base.getBytes(StandardCharsets.UTF_8).length>210)base=base.substring(0,base.offsetByCodePoints(base.length(),-1));
            String alias=base+"~gv-"+suffix(path);int attempt=0;while(!used.add(folded(alias)))alias=base+"~gv-"+suffix(path)+"-"+(++attempt);
            result.put(path,alias);
        }
        for(Map.Entry<String,Node> entry:node.children.entrySet())planChildren(entry.getValue(),parent.isEmpty()?entry.getKey():parent+"/"+entry.getKey(),result);
    }
    private static String suffix(String path){try{byte[] digest=MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8));StringBuilder text=new StringBuilder();for(int i=0;i<8;i++)text.append(String.format(Locale.ROOT,"%02x",digest[i]&255));return text.toString();}catch(Exception error){throw new IllegalStateException(error);}}
}
