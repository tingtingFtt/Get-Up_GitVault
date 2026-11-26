import type {ProjectSource} from './projectModel';
import {pullSourceOf} from './projectModel';
import {GitHubError} from './githubTransport';
import {redactLog} from './operationLog';

export interface UpdateCheckIssue {
 kind:'unavailable'|'permission'|'identity'|'address'|'branch';
 sourceKey:string;
 message:string;
 failedAt:string;
 status?:number;
}
type CheckedProject=ProjectSource&{origin?:ProjectSource;primarySource?:ProjectSource;updateCheckIssue?:UpdateCheckIssue;checkError?:string;lastCheckAttemptAt?:string};
export const updateCheckSourceKey=(source:ProjectSource)=>JSON.stringify([source.owner.toLowerCase(),source.repo.toLowerCase(),source.branch,source.repositoryId||null]);
export const updateCheckIssueLabel=(issue:UpdateCheckIssue)=>({unavailable:'来源不可访问',permission:'来源权限待确认',identity:'来源身份待核对',address:'来源地址已变更',branch:'来源分支不可访问'})[issue.kind];
/** A missing GitHub resource may be deleted, private, or inaccessible to this Token. */
export function updateCheckFailure(error:unknown,source:ProjectSource,failedAt=new Date().toISOString(),secrets:string[]=[]):UpdateCheckIssue|undefined {
 const e=error as {message?:string;name?:string;code?:string;sourceCheckKind?:string}|undefined;
 const message=e?.message||String(error);
 if(e?.name==='AbortError'||e?.code==='CANCELLED'||error instanceof GitHubError&&error.rateLimited||/rate.?limit|retry-after|请求受限|限流/i.test(message))return undefined;
 // Old saved errors did not retain HTTP status. Migrate only unambiguous API
 // messages; timeouts/TLS/unknown failures must not quarantine healthy sources.
 const status=error instanceof GitHubError?error.status:Number(/GitHub\s*\((\d{3})\)/i.exec(message)?.[1])||undefined;
 let kind:UpdateCheckIssue['kind']|undefined;
 if([301,302,307,308].includes(status||0))kind='address';
 else if(status===409&&/身份|identity/i.test(message))kind='identity';
 else if(status===401||status===403||/^(bad credentials|resource not accessible(?: by integration)?)[.!]?$/i.test(message))kind='permission';
 else if(status===404||status===410||/^(not found)[.!]?$/i.test(message))kind=e?.sourceCheckKind==='branch'?'branch':'unavailable';
 else if(status===422&&/no commit found|branch|分支/i.test(message))kind='branch';
 else if(/(?:来源|目标)仓库身份已变化/.test(message))kind='identity';
 return kind?{kind,sourceKey:updateCheckSourceKey(source),message:redactLog(message,secrets,1200),failedAt,status}:undefined;
}
export function activeUpdateCheckIssue(project:CheckedProject):UpdateCheckIssue|undefined {
 const source=pullSourceOf(project);
 if(project.updateCheckIssue)return project.updateCheckIssue.sourceKey===updateCheckSourceKey(source)?project.updateCheckIssue:undefined;
 return project.checkError?updateCheckFailure(new Error(project.checkError),source,project.lastCheckAttemptAt||''):undefined;
}
export function scheduledUpdateCheck(project:CheckedProject&{checkInterval:number;lastCheckedAt?:string},now:number){
 return !activeUpdateCheckIssue(project)&&project.checkInterval>0&&now-(new Date(project.lastCheckAttemptAt||project.lastCheckedAt||0).getTime()||0)>=Math.max(project.checkInterval*60000,project.checkError?60000:0);
}
