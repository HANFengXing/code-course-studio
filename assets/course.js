/* The player renders authored, evidence-linked teaching data. It executes no source code. */
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const make = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined && value !== null) element.textContent = String(value);
    return element;
  };
  const list = (value) => Array.isArray(value) ? value : [];
  const text = (id, value) => { $(id).textContent = value == null ? "" : String(value); };
  let course;
  try {
    course = JSON.parse($("course-data").textContent);
    if (course.schema_version !== 1 || !Array.isArray(course.chapters) || !course.chapters.length) {
      throw new Error("缺少支持的课程结构或章节。");
    }
  } catch (error) {
    const failure = make("div", "fatal-error");
    failure.setAttribute("role", "alert");
    failure.append(make("h1", "", "课程无法读取"), make("p", "", String(error.message)), make("p", "", "请重新运行课程构建与引用校验，再打开生成的 HTML。"));
    $("app").replaceWith(failure);
    return;
  }

  const references = new Map(list(course.evidence).map((reference) => [reference.id, reference]));
  const chapterIndex = new Map(course.chapters.map((chapter, index) => [chapter.id, index]));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    const choice = $("theme-select").value;
    document.documentElement.dataset.theme = choice === "system" ? (systemTheme.matches ? "dark" : "light") : choice;
    document.documentElement.dataset.themePreference = choice;
  }
  $("theme-select").addEventListener("change", applyTheme);
  systemTheme.addEventListener("change", applyTheme);
  applyTheme();
  const state = { chapter: 0, view: "business", step: 0, timer: null, playing: false, path: "all", query: "" };
  let openBeforePrint = [];
  const current = () => course.chapters[state.chapter];
  const steps = () => list(current().animation && current().animation.steps);
  const pad = (number) => String(number).padStart(2, "0");
  const scalar = (value) => value === null ? "null" : String(value);
  const empty = (container, message) => container.append(make("p", "empty-copy", message));

  function courseChapterIds() {
    if (state.path === "all") return course.chapters.map((chapter) => chapter.id);
    const path = list(course.study_paths)[Number(state.path)];
    return path ? list(path.chapter_ids).filter((id) => chapterIndex.has(id)) : [];
  }

  function searchableText(chapter) {
    return [chapter.title, chapter.question, chapter.summary, ...list(chapter.learning_goals),
      ...list(chapter.business_flow).flatMap((node) => [node.label, node.description, node.inputs, node.outputs]),
      ...list(chapter.code_flow).flatMap((node) => [node.label, node.description, node.inputs, node.outputs]),
      ...list(chapter.design_decisions).flatMap((item) => [item.title, item.decision, item.why, item.tradeoff]),
      ...list(chapter.implementation).flatMap((item) => [item.title, item.explanation])].join(" ").toLocaleLowerCase();
  }

  const searchIndex = new Map(course.chapters.map((chapter) => [chapter.id, searchableText(chapter)]));
  function visibleIds() {
    const tokens = state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return courseChapterIds().filter((id) => tokens.every((token) => searchIndex.get(id).includes(token)));
  }

  function renderNavigation() {
    const ids = visibleIds();
    const nav = $("chapter-nav");
    nav.replaceChildren();
    const ul = make("ol", "chapter-nav-list");
    for (const id of ids) {
      const index = chapterIndex.get(id);
      const chapter = course.chapters[index];
      const button = make("button", "chapter-link");
      button.type = "button";
      button.dataset.chapterId = id;
      button.dataset.testid = "chapter-link";
      if (index === state.chapter) button.setAttribute("aria-current", "page");
      button.append(make("span", "chapter-number", pad(index + 1)), make("span", "chapter-link-title", chapter.title));
      button.addEventListener("click", () => selectChapter(index, true));
      const li = make("li");
      li.append(button);
      ul.append(li);
    }
    if (ids.length) nav.append(ul); else empty(nav, "没有匹配章节。请缩短关键词或选择完整课程。");
    const select = $("chapter-select");
    select.replaceChildren();
    if (!ids.includes(current().id)) {
      const option = make("option", "", "当前：" + current().title + "（筛选外）");
      option.value = current().id;
      select.append(option);
    }
    for (const id of ids) {
      const index = chapterIndex.get(id);
      const option = make("option", "", pad(index + 1) + " · " + course.chapters[index].title);
      option.value = id;
      select.append(option);
    }
    select.value = current().id;
    text("search-status", state.query ? "找到 " + ids.length + " 个章节" : "共 " + ids.length + " 个章节");
    renderChapterPagination();
  }

  function renderChapterPagination() {
    const ids = courseChapterIds();
    const position = ids.indexOf(current().id);
    const previous = position > 0 ? ids[position - 1] : null;
    const next = position >= 0 && position < ids.length - 1 ? ids[position + 1] : null;
    $("previous-chapter").disabled = !previous;
    $("next-chapter").disabled = !next;
    text("previous-chapter", previous ? "← " + course.chapters[chapterIndex.get(previous)].title : "已经是第一章");
    text("next-chapter", next ? course.chapters[chapterIndex.get(next)].title + " →" : "本路线已到末章");
    $("previous-chapter").onclick = () => { if (previous) selectChapter(chapterIndex.get(previous), true); };
    $("next-chapter").onclick = () => { if (next) selectChapter(chapterIndex.get(next), true); };
  }

  function refsInChapter(chapter) {
    const result = new Set();
    const add = (items) => list(items).forEach((item) => list(item.evidence_ids).forEach((id) => result.add(id)));
    add(chapter.business_flow);
    add(chapter.code_flow);
    add(chapter.design_decisions);
    add(chapter.implementation);
    add(chapter.animation && chapter.animation.steps);
    add(chapter.quiz);
    return [...result];
  }

  function evidenceLinks(container, ids) {
    container.replaceChildren();
    for (const id of [...new Set(list(ids))]) {
      const ref = references.get(id);
      const button = make("button", "evidence-button", ref ? ref.path + ":" + ref.start_line + "-" + ref.end_line : "未找到引用：" + id);
      button.type = "button";
      button.dataset.testid = "evidence-link";
      button.dataset.evidenceId = id;
      button.disabled = !ref;
      button.setAttribute("aria-label", "查看源码 " + button.textContent);
      button.addEventListener("click", () => {
        const target = [...$("source-references").children].find((element) => element.dataset.evidenceId === id);
        if (!target) return;
        target.open = true;
        target.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
        target.querySelector("summary").focus({ preventScroll: true });
      });
      container.append(button);
    }
  }

  function renderOverview() {
    const overview = course.overview || {};
    const container = $("overview-content");
    container.replaceChildren();
    const dl = make("dl", "overview-grid");
    for (const [label, value] of [["适合读者", course.audience], ["业务问题", overview.problem], ["系统输入", overview.inputs], ["系统输出", overview.outputs], ["讲解范围", overview.scope]]) {
      if (value) dl.append(make("dt", "", label), make("dd", "", value));
    }
    container.append(dl);
    const box = make("div", "unknown-box");
    box.append(make("p", "", "待核实 / 未覆盖"));
    const unknowns = list(overview.unknowns);
    if (unknowns.length) {
      const ul = make("ul");
      unknowns.forEach((unknown) => ul.append(make("li", "", unknown)));
      box.append(ul);
    } else box.append(make("span", "", "课程没有列出未知项；这不表示工程行为已被完整验证。"));
    container.append(box);
  }

  function renderFlow() {
    const container = $("flow-list");
    const focusedNode = container.contains(document.activeElement) ? document.activeElement.dataset.nodeId : null;
    container.replaceChildren();
    const nodes = list(current()[state.view + "_flow"]);
    const edges = list(current()[state.view + "_edges"]);
    const nodeLabels = new Map(nodes.map((node) => [node.id, node.label]));
    const edgeKinds = { call: "调用", message: "消息", branch: "分支", data: "数据", return: "返回", sequence: "顺序" };
    const active = steps()[state.step];
    const key = state.view + "_node_id";
    $("flow-business").setAttribute("aria-selected", String(state.view === "business"));
    $("flow-code").setAttribute("aria-selected", String(state.view === "code"));
    $("flow-business").tabIndex = state.view === "business" ? 0 : -1;
    $("flow-code").tabIndex = state.view === "code" ? 0 : -1;
    container.setAttribute("aria-labelledby", "flow-" + state.view);
    text("view-hint", state.view === "business" ? "关注输入、结果与业务责任" : "关注代码职责与明确声明的关系");
    text("flow-limit", edges.length ? "课程选取场景中的有向关系如下；每条连接均有明确声明，未声明的连接不作推断。节点编号仅用于阅读定位。" : "阅读节点，未声明控制流关系。节点编号仅用于阅读定位，排列不代表执行顺序。");
    if (!nodes.length) { empty(container, "本章节未提供此视角的流程节点。"); return; }
    nodes.forEach((node, index) => {
      const targetStep = steps().findIndex((step) => step[key] === node.id);
      const item = make("li", "flow-item");
      const card = make(targetStep >= 0 ? "button" : "div", "flow-node");
      if (targetStep >= 0) {
        card.type = "button";
        card.addEventListener("click", () => { pause(); setStep(targetStep); });
        card.title = "跳到关联步骤 " + (targetStep + 1);
      }
      card.dataset.nodeId = node.id;
      card.dataset.testid = "flow-node";
      if (active && active[key] === node.id) card.setAttribute("aria-current", "step");
      const copy = make("span", "node-copy");
      copy.append(make("span", "node-label", node.label), make("span", "node-description", node.description));
      const io = make("span", "node-io");
      for (const [label, value] of [["输入", node.inputs], ["输出", node.outputs]]) {
        io.append(make("span", "node-io-label", label), make("span", "node-io-value", value == null || value === "" ? "未说明" : value));
      }
      copy.append(io);
      card.append(make("span", "node-number", pad(index + 1)), copy);
      item.append(card);
      if (list(node.evidence_ids).length) {
        const links = make("div", "evidence-links node-evidence");
        evidenceLinks(links, node.evidence_ids);
        item.append(links);
      }
      const outgoing = edges.filter((edge) => edge.from === node.id);
      if (outgoing.length) {
        const connections = make("ul", "flow-edges");
        connections.setAttribute("aria-label", node.label + "的已声明出边");
        outgoing.forEach((edge) => {
          const connection = make("li", "flow-edge");
          connection.dataset.testid = "flow-edge";
          connection.dataset.from = edge.from;
          connection.dataset.to = edge.to;
          connection.dataset.kind = edge.kind;
          connection.append(make("span", "flow-edge-kind", edgeKinds[edge.kind] || "未声明类型"));
          const description = make("span", "flow-edge-description");
          if (edge.label) description.append(make("span", "flow-edge-label", edge.label));
          description.append(make("span", "flow-edge-target", "→ " + (nodeLabels.get(edge.to) || "未定义节点：" + edge.to)));
          connection.append(description);
          connections.append(connection);
        });
        item.append(connections);
      }
      container.append(item);
    });
    if (focusedNode) {
      const replacement = [...container.querySelectorAll("button[data-node-id]")].find((button) => button.dataset.nodeId === focusedNode);
      if (replacement) replacement.focus({ preventScroll: true });
    }
    const activeNode = container.querySelector('[aria-current="step"]');
    if (activeNode) {
      const scroller = container.parentElement;
      const panelRect = scroller.getBoundingClientRect();
      const nodeRect = activeNode.getBoundingClientRect();
      const top = nodeRect.top - panelRect.top + scroller.scrollTop;
      if (nodeRect.top < panelRect.top + 12 || nodeRect.bottom > panelRect.bottom - 12) {
        scroller.scrollTo({ top: Math.max(0, top - 18), behavior: reducedMotion.matches ? "auto" : "smooth" });
      }
    }
  }

  function svgElement(tag, attrs, value) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs || {}).forEach(([key, val]) => node.setAttribute(key, String(val)));
    if (value !== undefined) node.textContent = String(value);
    return node;
  }

  function renderPoints(points) {
    const chart = $("points-chart");
    chart.replaceChildren(svgElement("title", { id: "points-title" }, "当前步骤的二维示意"));
    const data = list(points).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    $("points-figure").hidden = !data.length;
    $("points-empty").hidden = Boolean(data.length);
    if (!data.length) return;
    // Keep the same scale and group colors across a chapter so stepping never invents motion.
    const chapterPoints = steps().flatMap((step) => list(step.points)).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    chapterPoints.forEach((point) => {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    });
    const deltaX = Math.max(maxX - minX, 1), deltaY = Math.max(maxY - minY, 1);
    minX -= deltaX * .16; maxX += deltaX * .16; minY -= deltaY * .2; maxY += deltaY * .2;
    const x = (value) => 49 + (value - minX) / (maxX - minX) * 382;
    const y = (value) => 218 - (value - minY) / (maxY - minY) * 187;
    chart.append(svgElement("line", { x1: 49, y1: 218, x2: 431, y2: 218, class: "chart-axis" }), svgElement("line", { x1: 49, y1: 31, x2: 49, y2: 218, class: "chart-axis" }));
    const declaredAxes = current().animation && current().animation.point_axes;
    const xLabel = declaredAxes && declaredAxes.x_label ? declaredAxes.x_label : "示意 x（无单位）";
    const yLabel = declaredAxes && declaredAxes.y_label ? declaredAxes.y_label : "示意 y（无单位）";
    chart.append(svgElement("text", { x: 435, y: 244, "text-anchor": "end", class: "chart-label" }, xLabel), svgElement("text", { x: 10, y: 16, class: "chart-label" }, yLabel));
    const short = (value) => Number(value.toPrecision(3)).toString();
    for (let tick = 0; tick <= 2; tick += 1) {
      const tickX = minX + (maxX - minX) * tick / 2;
      const tickY = minY + (maxY - minY) * tick / 2;
      chart.append(svgElement("text", { x: x(tickX), y: 233, "text-anchor": "middle", class: "chart-tick" }, short(tickX)), svgElement("text", { x: 42, y: y(tickY) + 4, "text-anchor": "end", class: "chart-tick" }, short(tickY)));
    }
    const colors = ["var(--plot-group-1)", "var(--plot-group-2)", "var(--plot-group-3)", "var(--plot-group-4)", "var(--plot-group-5)"];
    const groups = [...new Set(chapterPoints.map((point) => point.group || ""))];
    const visibleGroups = [...new Set(data.map((point) => point.group || ""))];
    data.forEach((point) => {
      const dot = svgElement("circle", { cx: x(point.x), cy: y(point.y), r: 5, fill: colors[groups.indexOf(point.group || "") % colors.length], stroke: "var(--surface)", "stroke-width": 1.5 });
      dot.append(svgElement("title", {}, (point.label || "点") + "：x=" + point.x + "，y=" + point.y + (point.group ? "，组=" + point.group : "")));
      chart.append(dot);
      if (point.label) chart.append(svgElement("text", { x: x(point.x) + 8, y: y(point.y) - 7, class: "chart-dot-label" }, point.label));
    });
    text("points-caption", (declaredAxes ? "教学示意，单位由课程声明，不代表实测。" : "二维教学示意，坐标未声明实测单位。") + "本章各步共用坐标范围。" + (visibleGroups.some(Boolean) ? "分组：" + visibleGroups.filter(Boolean).join("、") + "。" : ""));
  }

  function renderStep() {
    const allSteps = steps();
    const step = allSteps[state.step];
    text("step-counter", allSteps.length ? pad(state.step + 1) + " / " + pad(allSteps.length) : "00 / 00");
    text("step-title", step ? step.title : "暂无步骤");
    text("step-explanation", step ? step.explanation : "课程未提供动画步骤，请阅读业务流程与源码引用。");
    evidenceLinks($("step-evidence"), step && step.evidence_ids);
    const table = $("state-table-body");
    table.replaceChildren();
    const values = step && step.state && typeof step.state === "object" ? step.state : {};
    const previous = state.step > 0 ? allSteps[state.step - 1].state || {} : {};
    let changedCount = 0;
    Object.entries(values).forEach(([key, value]) => {
      const changed = state.step > 0 && (!Object.prototype.hasOwnProperty.call(previous, key) || previous[key] !== value);
      if (changed) changedCount += 1;
      const row = make("tr", changed ? "state-changed" : "");
      const cell = make("td", "", scalar(value));
      if (changed) cell.title = Object.prototype.hasOwnProperty.call(previous, key) ? "上一步：" + scalar(previous[key]) : "本步骤新增观察项";
      row.append(make("td", "", key), cell);
      table.append(row);
    });
    if (!Object.keys(values).length) {
      const row = make("tr"), cell = make("td", "", "此步骤未提供数据状态。");
      cell.colSpan = 2; row.append(cell); table.append(row);
    }
    text("state-note", state.step > 0 ? "蓝色圆点表示与上一步不同的观察项（" + changedCount + " 项）。" : "状态取自课程步骤；本页不执行工程代码。");
    renderPoints(step && step.points);
    $("step-prev").disabled = !allSteps.length || state.step === 0;
    $("step-next").disabled = !allSteps.length || state.step === allSteps.length - 1;
    $("play-toggle").disabled = allSteps.length < 2;
    $("step-range").disabled = allSteps.length < 2;
    $("step-range").max = String(Math.max(0, allSteps.length - 1));
    $("step-range").value = String(state.step);
    $("step-range").setAttribute("aria-valuetext", step ? "第 " + (state.step + 1) + " 步，共 " + allSteps.length + " 步：" + step.title : "无步骤");
    text("progress-label", allSteps.length ? (state.step + 1) + " / " + allSteps.length : "0 / 0");
    renderFlow();
    updatePlaybackUI();
  }

  function updatePlaybackUI(message) {
    text("play-toggle", state.playing ? "暂停" : (state.step === steps().length - 1 && steps().length > 1 ? "重播" : "播放"));
    $("play-toggle").setAttribute("aria-pressed", String(state.playing));
    if (message) text("playback-status", message);
    else if (state.playing) text("playback-status", "正在播放 · 可随时暂停、拖动进度或切换视角。");
    else text("playback-status", reducedMotion.matches ? "已按减少动态效果偏好关闭过渡。可使用单步按钮查看全部内容。" : "点击流程节点可跳到对应步骤；左右方向键可操作进度滑块。");
  }

  function pause(message) {
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.timer = null;
    state.playing = false;
    updatePlaybackUI(message);
  }

  function schedule() {
    if (state.timer !== null) window.clearTimeout(state.timer);
    const speed = Number($("playback-speed").value) || 1;
    state.timer = window.setTimeout(() => {
      if (!state.playing) return;
      if (state.step < steps().length - 1) {
        setStep(state.step + 1);
        if (state.step === steps().length - 1) pause("本章节播放完毕。可重播、核对源码，或继续自测。");
        else schedule();
      } else pause("本章节播放完毕。");
    }, 2600 / speed);
  }

  function setStep(index) {
    state.step = Math.max(0, Math.min(index, Math.max(0, steps().length - 1)));
    renderStep();
  }

  function renderDesign() {
    const container = $("design-decisions");
    container.replaceChildren();
    const decisions = list(current().design_decisions);
    if (!decisions.length) return empty(container, "本章节尚未提供设计取舍。");
    for (const decision of decisions) {
      const item = make("article", "reading-item");
      const heading = make("h3", "", decision.title);
      const isDocumented = decision.status === "documented";
      heading.append(make("span", "status-label" + (isDocumented ? "" : " inferred"), isDocumented ? "有文档依据" : "作者推断 · 待核实"));
      const dl = make("dl", "decision-grid");
      for (const [label, value] of [["选择", decision.decision], ["原因", decision.why], ["代价", decision.tradeoff]]) dl.append(make("dt", "", label), make("dd", "", value));
      const links = make("div", "evidence-links");
      evidenceLinks(links, decision.evidence_ids);
      item.append(heading, dl, links);
      container.append(item);
    }
  }

  function renderImplementation() {
    const container = $("implementation");
    container.replaceChildren();
    const details = list(current().implementation);
    if (!details.length) return empty(container, "本章节尚未提供实现细节。");
    details.forEach((detail) => {
      const item = make("article", "reading-item");
      const links = make("div", "evidence-links");
      evidenceLinks(links, detail.evidence_ids);
      item.append(make("h3", "", detail.title), make("p", "", detail.explanation), links);
      container.append(item);
    });
  }

  function renderReferences() {
    const ids = refsInChapter(current());
    const container = $("source-references");
    container.replaceChildren();
    text("evidence-count", ids.length + " 处引用");
    if (!ids.length) return empty(container, "本章节没有源码引用。");
    ids.forEach((id, index) => {
      const ref = references.get(id);
      if (!ref) { empty(container, "引用缺失：" + id); return; }
      const details = make("details", "source-ref");
      details.id = "source-ref-" + index;
      details.dataset.evidenceId = id;
      details.dataset.testid = "source-reference";
      details.append(make("summary", "", ref.path + " · L" + ref.start_line + "-L" + ref.end_line));
      details.append(make("div", "source-meta", "引用 " + id + " · " + (ref.language || "text") + " · SHA-256 " + (ref.sha256 || "未提供")));
      const pre = make("pre", "source-code");
      pre.tabIndex = 0;
      pre.setAttribute("role", "region");
      pre.setAttribute("aria-label", ref.path + " 源码摘录");
      list(ref.lines).forEach((line) => {
        const row = make("span", "source-code-line");
        const number = make("span", "source-line-number", line.number);
        number.setAttribute("aria-label", "第 " + line.number + " 行");
        row.append(number, make("code", "", line.text));
        pre.append(row);
      });
      if (!list(ref.lines).length) pre.append(make("code", "", "未提供源码摘录，请重新构建课程。"));
      details.append(pre);
      container.append(details);
    });
  }

  function renderQuiz() {
    const container = $("quiz-list");
    container.replaceChildren();
    const quizzes = list(current().quiz);
    if (!quizzes.length) return empty(container, "本章节没有自测题。");
    quizzes.forEach((quiz, index) => {
      const form = make("form", "quiz-item");
      form.dataset.testid = "quiz-item";
      const fieldset = make("fieldset");
      fieldset.append(make("legend", "", (index + 1) + ". " + quiz.question));
      const options = make("div", "quiz-options");
      list(quiz.options).forEach((option, optionIndex) => {
        const label = make("label", "quiz-option");
        const input = make("input");
        input.type = "radio";
        input.name = "question-" + index;
        input.value = String(optionIndex);
        input.required = true;
        input.dataset.testid = "quiz-option";
        label.append(input, make("span", "", option));
        options.append(label);
      });
      fieldset.append(options);
      const button = make("button", "quiz-check", "检查答案");
      button.type = "submit";
      button.dataset.testid = "quiz-check";
      const feedback = make("div", "quiz-feedback");
      feedback.hidden = true;
      feedback.setAttribute("role", "status");
      form.append(fieldset, button, feedback);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const selected = form.querySelector("input:checked");
        if (!selected) { form.reportValidity(); return; }
        const correct = Number(selected.value) === quiz.answer_index;
        feedback.replaceChildren();
        feedback.classList.toggle("needs-review", !correct);
        feedback.append(make("p", "", correct ? "回答正确。" : "再核对一下：" + quiz.options[quiz.answer_index]), make("p", "", quiz.explanation));
        const links = make("div", "evidence-links");
        evidenceLinks(links, quiz.evidence_ids);
        feedback.append(links);
        feedback.hidden = false;
        button.textContent = "再次检查";
      });
      container.append(form);
    });
  }

  function selectChapter(index, moveFocus) {
    pause();
    state.chapter = Math.max(0, Math.min(index, course.chapters.length - 1));
    state.step = 0;
    const chapter = current();
    document.title = chapter.title + " · " + course.title;
    text("chapter-position", "第" + (state.chapter + 1) + "章 / 共" + course.chapters.length + "章");
    text("chapter-title", chapter.title);
    text("chapter-question", chapter.question);
    text("chapter-summary", chapter.summary);
    $("learning-goals").replaceChildren(...list(chapter.learning_goals).map((goal) => make("li", "", goal)));
    const animation = chapter.animation || {};
    text("animation-mode", animation.mode === "runtime_trace" ? "外部运行记录（未复现）" : "教学示意");
    text("animation-description", animation.description);
    $("trace-note").hidden = animation.mode !== "runtime_trace";
    text("trace-note", "记录来源：" + (animation.trace_path || "未提供路径") + " · SHA-256 " + (animation.trace_sha256 || "未提供") + "。本工具未执行或复现被分析工程。");
    renderNavigation();
    renderReferences();
    renderDesign();
    renderImplementation();
    renderQuiz();
    renderStep();
    if (moveFocus) {
      $("lesson").focus({ preventScroll: true });
      $("lesson").scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
    }
  }

  text("course-name", course.title);
  text("course-subtitle", course.subtitle);
  const build = course.build || {};
  text("build-note", "源码：" + (build.source_label || "未标注") + "\n引用 " + (build.evidence_count ?? list(course.evidence).length) + " 处 · " + course.chapters.length + " 章" + (build.generated_at ? "\n构建时间：" + build.generated_at : ""));
  text("source-fingerprint", build.source_fingerprint ? "源码快照 " + build.source_fingerprint.slice(0, 16) : "源码快照未标注");
  const allOption = make("option", "", "完整课程");
  allOption.value = "all";
  $("study-path").append(allOption);
  list(course.study_paths).forEach((path, index) => {
    const option = make("option", "", path.title);
    option.value = String(index);
    $("study-path").append(option);
  });
  renderOverview();
  list(course.glossary).forEach((entry) => $("glossary-list").append(make("dt", "", entry.term), make("dd", "", entry.meaning)));
  if (!list(course.glossary).length) $("glossary-list").append(make("dd", "empty-copy", "课程尚未提供术语解释。"));

  $("chapter-search").addEventListener("input", (event) => { state.query = event.target.value; renderNavigation(); });
  $("chapter-select").addEventListener("change", (event) => { if (chapterIndex.has(event.target.value)) selectChapter(chapterIndex.get(event.target.value), true); });
  $("study-path").addEventListener("change", (event) => {
    state.path = event.target.value;
    const ids = courseChapterIds();
    if (ids.length && !ids.includes(current().id)) selectChapter(chapterIndex.get(ids[0]), false);
    else renderNavigation();
  });
  for (const view of ["business", "code"]) {
    $("flow-" + view).addEventListener("click", () => { state.view = view; renderFlow(); });
    $("flow-" + view).addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        state.view = event.key === "Home" ? "business" : event.key === "End" ? "code" : state.view === "business" ? "code" : "business";
        renderFlow();
        $("flow-" + state.view).focus();
      }
    });
  }
  $("step-prev").addEventListener("click", () => { pause(); setStep(state.step - 1); });
  $("step-next").addEventListener("click", () => { pause(); setStep(state.step + 1); });
  $("step-range").addEventListener("input", (event) => { pause(); setStep(Number(event.target.value)); });
  $("play-toggle").addEventListener("click", () => {
    if (state.playing) return pause("已暂停。可单步查看状态与源码。");
    if (steps().length < 2) return;
    if (state.step === steps().length - 1) setStep(0);
    state.playing = true;
    updatePlaybackUI();
    schedule();
  });
  $("playback-speed").addEventListener("change", () => { if (state.playing) schedule(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && state.playing) pause("页面切到后台，播放已暂停。"); });
  reducedMotion.addEventListener("change", () => { if (state.playing) pause(); else updatePlaybackUI(); });
  $("print-course").addEventListener("click", () => window.print());
  window.addEventListener("beforeprint", () => {
    pause();
    openBeforePrint = [...document.querySelectorAll("details")].map((element) => [element, element.open]);
    openBeforePrint.forEach(([element]) => { element.open = true; });
  });
  window.addEventListener("afterprint", () => { openBeforePrint.forEach(([element, open]) => { element.open = open; }); openBeforePrint = []; });
  selectChapter(0, false);
})();
