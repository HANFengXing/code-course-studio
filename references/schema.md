# 课程 JSON 与界面契约 v1

所有教学文字是纯文本，不执行 HTML/Markdown。源代码由生成器从本地文件摘录，作者不得填造 excerpt。

顶层：schema_version=1，title，subtitle，audience，overview={problem,inputs,outputs,scope,unknowns:[string]}，chapters=[chapter]，evidence=[ref]，glossary=[{term,meaning}]，study_paths=[{title,chapter_ids:[string]}]。

chapter：id（全局唯一），title，question，summary，learning_goals:[string]，business_flow:[node]，code_flow:[node]，design_decisions:[{title,decision,why,tradeoff,status:documented|inferred,evidence_ids:[id]}]，implementation:[{title,explanation,evidence_ids:[id]}]，animation={mode:illustrative|runtime_trace,description,trace_path?:string,steps:[step]}，quiz:[{question,options:[string],answer_index:int,explanation,evidence_ids:[id]}]。

node：id（章节内部唯一），label，description，inputs:string，outputs:string，evidence_ids:[id]。节点数组是阅读顺序，不代表无条件执行顺序。

chapter 可提供 business_edges/code_edges:[{from,to,label,kind,evidence_ids}]；kind 为 sequence/call/message/branch/data/return，分别代表顺序、调用、消息、分支、数据、返回。显式条件边用于区分成功与拒绝等互斥路径；缺少边时渲染器不能自动连接相邻节点。关系端点和证据引用必须存在。这里只描述选取的场景，不声称完整调用图。

step：title，explanation，business_node_id，code_node_id，evidence_ids:[id]，state:{string:scalar}，points?:[{x:number,y:number,label:string,group?:string}]。数值必须有限；整数须在 JavaScript 安全整数范围内，64位ID等超大整数应写成字符串。points 仅是步骤中的可选二维示意，坐标轴不得冒充未声明的实测单位。animation 可带 point_axes={x_label,y_label} 明确坐标方向与单位。无 points 时界面仍能显示状态与流程高亮。切换业务/代码视图都可播放同一组步骤。

ref：id，path（相对源码根目录，无绝对路径、.. 或根外链接），start_line:int，end_line:int，expected_sha256?:string。生成器补充 sha256、language、lines:[{number:int,text:string}]。静态证据证明原文存在，不保证作者解释正确。

生成器补充顶层 build={source_label,source_fingerprint,evidence_count,chapter_count,validation,generated_at}。validation 只证明引用及结构校验。每章 animation.mode=illustrative 表示教学示意；runtime_trace 必须提供相对源码根目录的 trace_path，JSON 内有 steps 数组和 description，生成器读入替换 steps，并记录 trace_sha256。它的界面标签必须为“外部运行记录（未复现）”，不宣称本工具执行了被分析工程。

模板占位符：__COURSE_CSS__ / __COURSE_JS__ / __COURSE_DATA__。数据内嵌在 id=course-data 的 application/json script。文件命名 assets/course.html、assets/course.css、assets/course.js，根位于本 skill 目录。Python 渲染后是一份独立 HTML。不得依赖外网、fetch、服务器或 npm 构建。

前端要提供章节导航与搜索、学习路线、业务/代码切换、播放/暂停、上一步/下一步、进度滑块、速度、状态表、可选散点示意、源码引用展开、设计/实现/练习、术语、未知列表、打印样式、键盘可操作与窄屏重排。禁止通过 innerHTML 注入课程文字/源码。
