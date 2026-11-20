export type TaskType='General'|'Bug'|'Feature'|'Improvement'|'Request';
export type Domain='Software'|'Marketing'|'Sales'|'Operations'|'Other';
export type Kind='missing'|'ambiguity'|'contradiction'|'suggestion';
export type Task={title:string;description:string;type:TaskType;domain:Domain;criteria:string;context:string;scope?:string;outcome?:string;references?:string};
export type Finding={kind:Kind;title:string;detail:string;question?:string};
export type Analysis={mode:'demo'|'basic';score:number|null;summary:string;findings:Finding[];draft:string};
export const blank=():Task=>({title:'',description:'',type:'General',domain:'Other',criteria:'',context:''});
export const examples:{id:string;label:string;task:Task;result:Analysis}[]=[
{id:'software',label:'Software · Dark mode',task:{title:'Add dark mode',description:'Users want dark mode on web and mobile. Follow the design from Figma and ship it in the next sprint.',type:'Feature',domain:'Software',criteria:'',context:''},result:{mode:'demo',score:72,summary:'Useful starting point, but the scope and completion criteria are unclear.',findings:[
{kind:'missing',title:'Completion criteria are missing',detail:'No testable definition of done is specified.',question:'What must work to consider the feature finished?'},
{kind:'ambiguity',title:'Dark mode has several interpretations',detail:'System theme, manual toggle, theme persistence, and included screens are all unspecified.',question:'Should the app follow device settings or offer a toggle?'},
{kind:'missing',title:'Design reference is incomplete',detail:'A Figma file is mentioned without a link to approved screens.',question:'Which frames should the team implement?'}],draft:'Add dark mode to the web and mobile apps.\n\nGoal: Provide a dark visual theme on agreed screens.\n\nOpen questions:\n• Which screens are in scope?\n• Manual toggle or automatic system preference?\n• Where are the approved Figma frames?\n\nCompletion criteria: To be confirmed.'}},
{id:'marketing',label:'Marketing · Campaign',task:{title:'Improve the launch campaign',description:'Make our campaign stronger and reach more people. Use social channels and email. It needs to perform better than last time.',type:'Improvement',domain:'Marketing',criteria:'',context:''},result:{mode:'demo',score:54,summary:'The target audience and measurable outcomes are missing.',findings:[
{kind:'ambiguity',title:'“Perform better” is not measurable',detail:'No metric or baseline is provided.',question:'Which KPI should improve, and by how much?'},
{kind:'missing',title:'Target audience is unknown',detail:'Channels are listed without defining the audience.',question:'Who should the campaign target?'},
{kind:'missing',title:'Ownership and timing are missing',detail:'No owner, launch date, or budget is supplied.',question:'Who owns delivery and when is it due?'}],draft:'Improve the launch campaign on selected email and social channels.\n\nClarify before execution:\n• Target audience\n• Primary KPI and baseline\n• Budget, owner, and launch date\n\nSuccess criteria: Pending measurable target.'}},
{id:'sales',label:'Sales · Outreach',task:{title:'Follow up with every lead today',description:'Only contact qualified leads. Do not send messages before the new copy is approved tomorrow. Everyone must be contacted by end of today.',type:'General',domain:'Sales',criteria:'',context:''},result:{mode:'demo',score:47,summary:'The instructions conflict on both audience and timing.',findings:[
{kind:'contradiction',title:'Deadline conflicts with approval',detail:'Messages must be sent today but cannot be sent until approval tomorrow.',question:'Should outreach wait, or should the deadline change?'},
{kind:'contradiction',title:'Audience conflicts',detail:'The title says every lead; the description says qualified leads only.',question:'Which leads should be contacted?'},
{kind:'missing',title:'Qualification rules are absent',detail:'No definition of a qualified lead was provided.',question:'What makes a lead qualified?'}],draft:'Prepare follow-up outreach for qualified leads.\n\nBlocked by: Messaging approval expected tomorrow.\n\nResolve first:\n• Outreach deadline versus approval date\n• All leads versus qualified leads\n• Lead qualification definition\n\nDo not start sending until conflicts are resolved.'}}
];
const norm=(s:string)=>s.trim().replace(/\s+/g,' ').toLowerCase();
export function analyze(task:Task):Analysis{
const ex=examples.find(e=>e.task.type===task.type&&e.task.domain===task.domain&&(['title','description','criteria','context'] as const).every(k=>norm(e.task[k])===norm(task[k])));
if(ex)return ex.result;
const findings:Finding[]=[];
if(!task.title.trim())findings.push({kind:'missing',title:'Title is empty',detail:'Give the request a recognizable name.'});
if(!task.description.trim())findings.push({kind:'missing',title:'Description is empty',detail:'Explain the requested work and its intended outcome.'});
if(task.description.trim()&&task.description.trim().length<80)findings.push({kind:'suggestion',title:'Consider more context',detail:'This is a short description. Check whether the goal, constraints, and desired outcome are understandable.'});
if(task.title.trim()&&task.title.trim().length<12)findings.push({kind:'suggestion',title:'Consider a more specific title',detail:'A descriptive title helps readers identify the work.'});
if(!task.criteria.trim()&&['Bug','Feature','Improvement'].includes(task.type))findings.push({kind:'suggestion',title:'Consider completion criteria',detail:'This kind of work often benefits from a definition of done.',question:'How will the work be verified?'});
if(!findings.length)findings.push({kind:'suggestion',title:'Basic checks passed',detail:'No simple structural issues found. Meaning, accuracy, and contradictions have NOT been checked.'});
return{mode:'basic',score:null,summary:'Basic structure checks only. Real AI analysis is not connected.',findings,draft:[task.title||'[Task title]',task.description||'[Description]',task.criteria?'Completion criteria:\n'+task.criteria:'',task.context?'Additional context:\n'+task.context:''].filter(Boolean).join('\n\n')};
}
