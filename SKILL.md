---
name: code-course-studio
description: "将软件代码库制作成可追溯源码的中文 HTML 交互课程，讲解业务流程、代码流程、设计取舍与实现细节，并制作逐步动画。适用于代码接手、教学和模块理解；单个函数问答无需生成课程。"
metadata:
  version: "0.1.0"
---

# 代码课程工作室

交付让学习者能够解释、定位、预测行为的课程。按用户的两条标准选择内容：适合理解；具有理解价值。不要用目录覆盖率、动画数量或篇幅代替教学质量。

## 先确定讲什么

确认目标源码目录、读者基础和最重要的学习场景；已给出的信息不重复询问。缺少目标仓库时可以完成工具与明确标注的教学样例，但不能声称已经解释了用户的工程。默认面向懂编程但不熟悉该系统的工程师，这是可调整的假设。

采用“系统地图 → 一个端到端业务场景 → 关键模块 → 关键代码片段”的递进方式。优先解释一个正常路径和一个会改变结果的异常路径。根据项目结构拆成子系统课程；不要把几千个函数挤成一张调用图。

初次制作或需要判断内容价值时阅读 [教学与证据准则](references/teaching.md)。撰写课程 JSON 时阅读 [数据契约](references/schema.md)。

## 源码调查与课程制作

本技能的 `scripts/course_tool.py` 使用 Python 3.10+ 标准库，无 API 或联网行为。把 `<skill>` 替换为本技能目录，输出放在用户指定位置或项目外的独立课程目录。

```text
python <skill>/scripts/course_tool.py index --source <repo> --out <work>/index
python <skill>/scripts/course_tool.py brief --index <work>/index/index.json --module <subsystem> --out <work>/module-brief.md
python <skill>/scripts/course_tool.py search --source <repo> --index <work>/index/index.json --text <entry-or-message-name>
python <skill>/scripts/course_tool.py excerpt --source <repo> --path <relative-file> --start <line> --end <line>
```

- 先看 coverage.json 的跳过原因和模块统计；测试、文档、配置保留为教学证据。扫描预算不足时分模块重跑或明确调整参数，不能无声忽略大文件。
- C/C++ 等语言的符号是词法候选，不是经编译器验证的定义或调用关系。Python 用 AST 识别定义，仍未生成调用图。需要可靠 C++ 语义时使用工程已有的编译数据库/语言服务，并记录编译配置与解析缺口。
- 用有界调查包逐个阅读重要模块。沿入口、调用、消息队列与共享状态追踪场景；跨线程的播放顺序不等于真实全局时序。将确认的代码边与消息边在解释中说清。
- 重要解释绑定精确文件与行号；设计意图没有文档/作者证据时标为推断。示例数值、简化模型、未覆盖模块与未知问题均应可见。
- 原始片段由工具提取，不能改写后冒充原代码。简化解释放在正文，且能回到真实源码。
- 用显式 business_edges/code_edges 描述流程关系，条件写在边上；节点的阅读顺序不能当作执行顺序。动画状态要对应当前高亮阶段，不能在检查节点提前显示后续提交结果；区分局部容器大小与循环结束后才写回的统计字段。

按照 schema 创建 course.json。模型负责语义调查与教学编排，扫描器不会自动理解业务。每章必须包含业务流程、代码流程、设计取舍、实现细节、可单步演示和迁移题。取舍要回答“为何如此、何时不适用”；实现要优先讲数据约束、数据结构、状态生命周期、边界与性能约束，不做逐行翻译。

## 动画与真实性

`illustrative` 是教学示意：步骤和数值由作者依据代码制作，用于预测或解释行为，不冒充运行记录。状态变化与分支条件应可手算或用小型测试复核。用不同章节/场景呈现正常、超时、输入异常或其他重要分支。

`runtime_trace` 仅在用户提供真实事件记录时使用：指定 trace_path，工具读入 steps 并固定散列。播放器将其标为“外部运行记录（未复现）”；结构校验不证明记录真实性，也不表示工具执行了工程。若要执行原工程，按用户环境、指令和测试权限进行，另外记录运行命令与产物证据。

先逐步改变一件事：当前节点、关键状态、该步骤源码。二维散点图仅在坐标和单位有明确教学意义时使用，避免与解释无关的装饰动画。默认暂停，可播放、回退、单步、调速；无动画也能完整阅读。

## 验证与交付

```text
python <skill>/scripts/course_tool.py validate --source <repo> --course <work>/course.json --report <work>/validation.json
python <skill>/scripts/course_tool.py build --source <repo> --course <work>/course.json --out <output>
```

build 生成可离线打开的 index.html、固定源码散列的 course.lock.json 和 validation.json。后续用 lock 文件构建，源码或运行记录变化会报错；重新调查后才能更新引用。校验通过只证明引用、结构和关系合法，不证明解释、设计意图或教学效果正确。

交付前验证关键内容与引用一致，操作章节切换、业务/代码切换、播放/暂停/单步、引用展开与答题反馈；检查桌面和窄屏。复杂课程可委托独立审查者仅据源码和课程检查解释与迁移题。把发现的实质错误修正后再交付。

最终提供课程入口、可复用 skill/工具、运行方法、覆盖范围与重要未知。用户源码默认只用于指定的本地课程；用户另行要求上传、发布或远程模型调用时再按其范围执行。不要把整库、日志或二进制打包进教学成果。
