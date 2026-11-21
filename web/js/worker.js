import { parseCsv } from "./csv.js?v=20261121a";
import { findDuplicateGroups } from "./match.js?v=20261121a";
import { buildRecords, toPublic } from "./records.js?v=20261121a";

const BUILD = "20261121a";

self.onmessage = async (event) => {
  const { file, mapping } = event.data;
  try {
    const report = (phase, pct) => self.postMessage({ type: "progress", phase, pct, build: BUILD });
    report("Reading the file", 4);
    const text = await file.text();
    report("Parsing the CSV", 12);
    const parsed = parseCsv(text);
    if (!parsed.headers.length) throw new Error("No header row was found in that file.");
    if (!parsed.rows.length) throw new Error("The file has headers but no data rows.");
    report(`Parsed ${parsed.rows.length.toLocaleString()} rows`, 24);
    const records = buildRecords(parsed.headers, parsed.rows, mapping);
    report("Comparing websites, domains, and IDs", 34);
    const result = findDuplicateGroups(records, (update) => report(update.phase, update.pct));
    const publicRecords = {};
    for (const group of result.groups) {
      for (const key of group.memberKeys) {
        if (publicRecords[key]) continue;
        const record = result.recordByKey.get(key);
        if (record) publicRecords[key] = toPublic(record);
      }
    }
    report("Done", 100);
    self.postMessage({
      type: "done",
      build: BUILD,
      groups: result.groups,
      records: publicRecords,
      warnings: result.warnings,
      accountCount: records.length,
      rowCount: parsed.rows.length,
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error && error.message ? error.message : "The file could not be read.",
    });
  }
};
