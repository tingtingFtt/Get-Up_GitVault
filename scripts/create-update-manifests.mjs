import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const code=Number(process.env.GITVAULT_VERSION_CODE),version=process.env.GITVAULT_VERSION_NAME;
if(!Number.isSafeInteger(code)||code<=0||!/^\d+\.\d+\.\d+$/.test(version||''))throw new Error('Invalid Android version');
for(const channel of ['debug','release']){
 const name=`GitVault-${channel}.apk`,bytes=await readFile(`android-update/${name}`);
 await writeFile(`android-update/latest-${channel}.json`,JSON.stringify({packageId:'com.gitvault.app'+(channel==='debug'?'.debug':''),versionCode:code,versionName:version,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),url:`https://github.com/tingtingFtt/Get-Up_GitVault/releases/download/android-v${version}/${name}`},null,2)+'\n');
}
