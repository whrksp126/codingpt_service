// 편집기 번들 — PC(ESM 모듈) 와 폰(IIFE 를 문자열로 감싼 TS 모듈, WebView 에 인라인) 두 벌을 같은 소스에서 만든다.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const common = { entryPoints: [path.join(here, "src/index.js")], bundle: true, minify: true, loader: { ".css": "text" }, target: ["safari15", "chrome100"], legalComments: "none" };
const pcOut = path.join(here, "../src/vendor/issue-editor/issue-editor.js");
await build({ ...common, format: "esm", outfile: pcOut });
const r = await build({ ...common, format: "iife", write: false });
const js = r.outputFiles[0].text;
const appOut = path.resolve(here, "../../../codingpt_app/src/workspace/issues/issueEditorBundle.ts");
fs.writeFileSync(appOut, "// 생성 파일 — 손대지 말 것. 정본: codingpt_service/codingpt_pc/editor (npm run build)\n/* eslint-disable */\nexport default " + JSON.stringify(js) + ";\n");
console.log("pc", (fs.statSync(pcOut).size / 1024).toFixed(0) + "KB", "app", (js.length / 1024).toFixed(0) + "KB");
