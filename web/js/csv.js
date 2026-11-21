/** Parse a CSV in memory. Quoted commas and newlines are preserved. */

export function parseCsv(text, { maxDataRows = Infinity } = {}) {
  let source = String(text || "");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  source = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const delimiter = detectDelimiter(source);
  const table = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      field = "";
      pushRow(table, row);
      row = [];
      if (table.length >= 1 + maxDataRows) break;
      continue;
    }
    field += char;
  }

  if (!inQuotes && (field.length || row.length)) {
    row.push(field);
    pushRow(table, row);
  }

  const headerCells = (table[0] || []).map((cell) => cell.trim());
  const seen = new Map();
  const headers = headerCells.map((cell) => {
    const name = cell || "Column";
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} (${count})`;
  });

  return {
    headers,
    rows: table.slice(1),
    delimiter,
  };
}

export function sampleValues(headers, rows) {
  const samples = {};
  headers.forEach((header, index) => {
    for (const row of rows) {
      const value = String(row[index] ?? "").trim();
      if (value) {
        samples[header] = value;
        break;
      }
    }
  });
  return samples;
}

function pushRow(table, row) {
  if (row.some((cell) => String(cell).trim() !== "")) table.push(row);
}

function detectDelimiter(text) {
  let line = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) break;
    line += char;
  }

  const scores = [
    [",", countChar(line, ",")],
    [";", countChar(line, ";")],
    ["\t", countChar(line, "\t")],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ",";
}

function countChar(text, char) {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === char) count += 1;
  return count;
}
