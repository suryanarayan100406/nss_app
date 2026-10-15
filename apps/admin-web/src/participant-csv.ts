export type ParticipantCsvRow = {
  name: string;
  rollNo: string | null;
  role: string;
  department: string;
  batch: string;
  contribution: string;
  attendance: string;
};

const MAX_CSV_LENGTH = 1_000_000;
const MAX_DATA_ROWS = 5_000;
const MAX_COLUMNS = 20;
const MAX_CELL_LENGTH = 500;
const REQUIRED_HEADERS = ['name', 'roll no', 'role', 'department', 'batch', 'contribution', 'attendance'] as const;

const normaliseHeader = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

function parseRows(input: string): string[][] {
  if (input.length > MAX_CSV_LENGTH) throw new Error('CSV is too large. Import up to 1 MB at a time.');

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let closedQuote = false;

  const pushCell = () => {
    if (cell.length > MAX_CELL_LENGTH) throw new Error('CSV cells must be 500 characters or fewer.');
    row.push(cell);
    cell = '';
    closedQuote = false;
  };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value.trim() !== '')) {
      if (row.length > MAX_COLUMNS) throw new Error(`CSV rows may contain at most ${MAX_COLUMNS} columns.`);
      rows.push(row);
      if (rows.length > MAX_DATA_ROWS + 1) throw new Error(`CSV imports are limited to ${MAX_DATA_ROWS} participant rows.`);
    }
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (closedQuote) {
      if (character === ' ' || character === '\t') continue;
      if (character === ',') {
        pushCell();
        continue;
      }
      if (character === '\r' || character === '\n') {
        if (character === '\r' && input[index + 1] === '\n') index += 1;
        pushRow();
        continue;
      }
      throw new Error('CSV has characters after a closing quote.');
    }

    if (character === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (character === ',') {
      pushCell();
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      cell += character;
    }
  }

  if (inQuotes) throw new Error('CSV has an unterminated quoted field.');
  if (cell.length > 0 || row.length > 0) pushRow();
  return rows;
}

export function parseParticipantCsv(input: string): ParticipantCsvRow[] {
  const rows = parseRows(input.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('Import needs a header and at least one participant row.');

  const headers = rows[0].map(normaliseHeader);
  const aliases: Record<string, string> = { rollno: 'roll no' };
  const canonicalHeaders = headers.map((header) => aliases[header] || header);
  const duplicate = canonicalHeaders.find((header, index) => canonicalHeaders.indexOf(header) !== index);
  if (duplicate) throw new Error(`CSV contains the header more than once: ${duplicate}.`);
  const missing = REQUIRED_HEADERS.filter((header) => !canonicalHeaders.includes(header));
  if (missing.length) throw new Error(`CSV is missing required header(s): ${missing.join(', ')}.`);

  const indexOf = (header: string) => canonicalHeaders.indexOf(header);
  const valueAt = (values: string[], header: string) => values[indexOf(header)]?.trim() || '';
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length > canonicalHeaders.length) throw new Error(`CSV row ${rowIndex + 2} has more fields than its header.`);
    const name = valueAt(values, 'name');
    if (!name) throw new Error(`CSV row ${rowIndex + 2} needs a participant name.`);
    return {
      name,
      rollNo: valueAt(values, 'roll no') || null,
      role: valueAt(values, 'role'),
      department: valueAt(values, 'department'),
      batch: valueAt(values, 'batch'),
      contribution: valueAt(values, 'contribution'),
      attendance: valueAt(values, 'attendance') || 'present',
    };
  });
}
