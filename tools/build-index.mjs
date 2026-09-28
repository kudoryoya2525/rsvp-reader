// aozora-index.json を生成するビルドスクリプト（Node標準機能のみ・依存パッケージなし）
//
// データ源:
//   - 作品一覧CSV: https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip
//     (青空文庫公式サイト。GitHub の aozorabunko/aozorabunko は 2023-03 頃に消失/非公開化されており使用不可)
//   - 作品HTML実体の存在確認: https://github.com/takahashim/aozorabunko_html (2023-03-22 時点の凍結ミラー。
//     raw.githubusercontent.com は CORS 許可ヘッダーを返すためブラウザから取得可能。aozora.gr.jp 本体はCORS非対応)
//
// 実行: node tools/build-index.mjs
// 出力: aozora-index.json （setup画面の検索欄を開いたときにブラウザ側で遅延fetchする）

import { writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const CSV_ZIP_URL = "https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip";
const MIRROR_TREE_URL = "https://api.github.com/repos/takahashim/aozorabunko_html/git/trees/master?recursive=1";
const OUT_PATH = new URL("../aozora-index.json", import.meta.url);

async function fetchBuffer(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fetch failed ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 単一ファイルを想定した最小限のZIP展開（store/deflate対応） */
function unzipSingleFile(buf) {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found (not a valid zip)");
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const cdSig = 0x02014b50;
  if (buf.readUInt32LE(cdOffset) !== cdSig) throw new Error("central directory signature mismatch");
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  const name = buf.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString("utf-8");

  const lfhSig = 0x04034b50;
  if (buf.readUInt32LE(localOffset) !== lfhSig) throw new Error("local file header signature mismatch");
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  const compData = buf.slice(dataStart, dataStart + compSize);

  const data = method === 0 ? compData : inflateRawSync(compData);
  return { name, data };
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    rows.push(parseCsvLine(lines[i]));
  }
  return { idx, rows };
}

async function main() {
  console.log("CSV(zip)取得中...");
  const zipBuf = await fetchBuffer(CSV_ZIP_URL);
  const { name, data } = unzipSingleFile(zipBuf);
  console.log("展開:", name, data.length, "bytes");
  let text = data.toString("utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM除去

  const { idx, rows } = parseCsv(text);
  console.log("CSV行数:", rows.length);

  console.log("ミラーリポジトリのファイル一覧取得中...");
  const treeRes = await fetch(MIRROR_TREE_URL, {
    headers: { "User-Agent": "rsvp-reader-build-index", Accept: "application/vnd.github+json" },
  });
  if (!treeRes.ok) throw new Error(`tree fetch failed: ${treeRes.status}`);
  const tree = await treeRes.json();
  if (tree.truncated) console.warn("警告: GitHub tree APIの結果が truncated されています");
  const existing = new Set(
    tree.tree.filter((t) => t.type === "blob" && /^cards\/\d{6}\/files\/.+\.html?$/.test(t.path)).map((t) => t.path)
  );
  console.log("ミラー内HTMLファイル数:", existing.size);

  const col = (row, name) => row[idx[name]] ?? "";

  const seen = new Set();
  const records = [];
  for (const row of rows) {
    const role = col(row, "役割フラグ");
    if (role !== "著者") continue; // 著者以外(翻訳者・編者等)の行は索引に含めない
    const copyrightFlag = col(row, "作品著作権フラグ");
    if (copyrightFlag !== "なし") continue; // 著作権が切れていない作品は除外
    const workId = col(row, "作品ID");
    if (seen.has(workId)) continue;
    const htmlUrl = col(row, "XHTML/HTMLファイルURL");
    if (!htmlUrl) continue;
    const relMatch = htmlUrl.match(/\/cards\/(\d{6})\/files\/([^/]+\.html?)$/i);
    if (!relMatch) continue;
    const relpath = `${relMatch[1]}/files/${relMatch[2]}`;
    if (!existing.has(`cards/${relpath}`)) continue; // 凍結ミラーに実体が無いものは除外

    const title = col(row, "作品名");
    const yomi = col(row, "ソート用読み");
    const sei = col(row, "姓");
    const mei = col(row, "名");
    const author = [sei, mei].filter(Boolean).join(" ");

    seen.add(workId);
    records.push([title, yomi, author, relpath]);
  }

  records.sort((a, b) => a[0].localeCompare(b[0], "ja"));
  console.log("索引件数:", records.length);

  const out = { v: 1, base: "https://raw.githubusercontent.com/takahashim/aozorabunko_html/master/cards/", n: records.length, d: records };
  writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log("書き出し完了:", OUT_PATH.pathname);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
