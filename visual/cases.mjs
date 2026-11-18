// Visual use cases covered by the harness (ids from TESTING.md "Visual use cases").
// Each: { id, path, steps?, ready?, mask?, fixText?, fixJs?, settle? } (format of pazka/MyMurderParty visual/).
// - steps(page, base): what a visitor does before the shot, through the page itself (typing in the editor,
//   dropping a file on the drop zone). Every shot starts in a NEW browser context: a fresh visitor.
// - ready: a JS expression that must become true before the shot.
// - fixText: { selector: text } replaced before the shot (the "Last update" dates come from the clock).
// - mask: CSS selectors made invisible before the shot (layout kept).
// The server keeps ONE shared paste and ONE file: cases run in this order on one fresh container
// (visual/run.sh), and a step only changes the shared state when it is not there yet, so every width of a
// case sees the same state.
export const WIDTHS = [1400, 1024, 390];

const js = (v) => JSON.stringify(v);
const TEXT = "Shared shopping list\n- 2 baguettes\n- olive oil\n- coffee (the good one)\nCall Marc before 6 pm";
const FILE = { name: "holiday-photos.zip", size: 123456 }; // fmtSize: "120.6 Ko"
const DATE = "01/01/2026 12:00:00"; // what fmtTime shows, pinned

// the page has answered /all (the date leaves "never"), /limits (production 2 GiB) and /title (TITLE)
const LOADED = `document.getElementById("txtMaj").innerText !== "never"
  && document.getElementById("maxSize").innerText === "2.00 Go"
  && document.title === "QuickPaste" && !!document.querySelector(".ql-editor")`;
const HAS_TEXT = `document.querySelector(".ql-editor").innerText.includes("Call Marc before 6 pm")`;
const HAS_FILE = `!document.getElementById("download-field").classList.contains("hidden")
  && document.getElementById("fileNameMaj").innerText === ${js(FILE.name)}`;
const DATES = { "#txtMaj": DATE };

async function must(p, expression, what, ms) {
  if (!(await p.waitFor(expression, ms))) throw new Error(`step failed: ${what}`);
}
// like a visitor: click in the editor, then type (Input.insertText fires the events Quill listens to)
async function typeInEditor(p, text) {
  await must(p, `(() => { const e = document.querySelector(".ql-editor"); if (!e) return false; e.focus(); return true; })()`, "focus the editor");
  await p.send("Input.insertText", { text });
}
// what a drag and drop of a file does: dragenter, dragover, drop on #drop-zone with the file in dataTransfer
const dragEvents = (types, withDrop) => `(() => {
  const dt = new DataTransfer();
  ${withDrop ? `dt.items.add(new File([new Uint8Array(${FILE.size}).fill(65)], ${js(FILE.name)}, { type: "application/zip" }));` : ""}
  const zone = document.getElementById("drop-zone");
  for (const type of ${js(types)}) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  return true;
})()`;

async function ensureText(p, base) {
  await must(p, LOADED, "page loaded");
  if (await p.evaluate(HAS_TEXT)) return;
  await typeInEditor(p, TEXT);
  // the server answers the sender with new_text (date updated); then a fresh load must show the saved text
  await must(p, `fetch("/all").then((r) => r.json()).then((d) => JSON.stringify(d.txt.val || "").includes("Call Marc"))`, "text saved on the server");
  await p.goto(base + "/");
  await must(p, `${LOADED} && ${HAS_TEXT}`, "saved text shown after a reload");
}

async function ensureFile(p, base) {
  await ensureText(p, base);
  if (await p.evaluate(HAS_FILE)) return;
  await p.evaluate(dragEvents(["dragenter", "dragover", "drop"], true));
  await must(p, HAS_FILE, "dropped file shown with its name", 20000);
  await p.goto(base + "/");
  await must(p, `${LOADED} && ${HAS_TEXT} && ${HAS_FILE}`, "shared file shown after a reload");
}

export const CASES = [
  {
    id: "E1-empty",
    path: "/",
    ready: `${LOADED} && document.querySelector(".ql-editor").innerText.trim() === ""
      && !document.getElementById("no-file-yet").classList.contains("hidden")`,
    fixText: DATES,
  },
  {
    id: "E2-drag-over",
    path: "/",
    steps: async (p) => {
      await must(p, LOADED, "page loaded");
      await p.evaluate(dragEvents(["dragenter", "dragover"], false));
    },
    ready: `document.getElementById("drop-zone").classList.contains("drag-over")`,
    fixText: DATES,
  },
  {
    id: "T1-text",
    path: "/",
    steps: ensureText,
    ready: `${LOADED} && ${HAS_TEXT} && !document.getElementById("no-file-yet").classList.contains("hidden")`,
    fixText: DATES,
  },
  {
    id: "T2-text-too-big",
    path: "/",
    steps: async (p, base) => {
      await ensureText(p, base);
      // the server refuses a paste over MAX_TEXT_SIZE (production 100 000) and tells only the sender.
      // Words with spaces, like a real paste: one unbroken 100 000-letter word makes the page 650 000 px wide
      // at 390 px (TESTING.md, notes), too large for a screenshot.
      await must(p, `(() => { const e = document.querySelector(".ql-editor"); e.focus();
        const s = getSelection(); s.selectAllChildren(e); s.collapseToEnd(); return true; })()`, "cursor at the end");
      await p.send("Input.insertText", { text: "paste ".repeat(16700) });
    },
    ready: `document.getElementById("error").innerText.startsWith("Text is too big ! Maximum length is 100000")`,
    fixText: DATES,
    // typing scrolled the pad to its end: back to the top, where the visitor reads the error
    fixJs: `(() => { document.getElementById("text-edit").scrollTop = 0; document.querySelector(".ql-container .ql-editor").scrollTop = 0; return true; })()`,
  },
  {
    id: "F1-file-shared",
    path: "/",
    steps: ensureFile,
    ready: `${LOADED} && ${HAS_TEXT} && ${HAS_FILE} && document.getElementById("fileSizeMaj").innerText === "120.6 Ko"`,
    fixText: { ...DATES, "#fileMaj": DATE },
  },
  {
    id: "F2-file-drag-over",
    path: "/",
    steps: async (p, base) => {
      await ensureFile(p, base);
      await p.evaluate(dragEvents(["dragenter", "dragover"], false));
    },
    ready: `document.getElementById("drop-zone").classList.contains("drag-over") && ${HAS_FILE}`,
    fixText: { ...DATES, "#fileMaj": DATE },
  },
];
