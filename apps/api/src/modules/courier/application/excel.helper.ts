import ExcelJS from "exceljs";
import { SpreadsheetError } from "./spreadsheet-errors";

export interface ImportRowResult {
  rowNumber: number;
  data: Record<string, string | null>;
  error?: string;
}

export interface ImportSummary {
  totalRows: number;
  imported: ImportRowResult[];
  rejected: ImportRowResult[];
}

function normalizeCell(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const str = String(value).trim();
  return str === "" ? null : str;
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const dmY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (dmY) {
    const [, d, m, y] = dmY;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return iso[0];
  return value;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Mappings of database field names to the headers found in Excel
export const RAW_IMPORT_COLUMNS: Array<{ header: string; field: string; aliases: string[] }> = [
  { header: "Date", field: "date", aliases: ["date", "تاريخ", "تاريخ الطلب", "التاريخ"] },
  { header: "Installation type", field: "installationType", aliases: ["installation type", "installationtype", "نوع التركيب", "العملية", "نوع الطلب"] },
  { header: "SIM", field: "sim", aliases: ["sim", "شريحة", "مزود الشريحة", "نوع الشريحة"] },
  { header: "TID", field: "tid", aliases: ["tid", "terml id", "termlid", "رقم tid", "رقم المعاملة", "الرمز الذكي"] },
  { header: "OTP", field: "otp", aliases: ["otp", "رمز otp", "رمز التحقق"] },
  { header: "TICKETING HOLOULY", field: "ticketingHolouly", aliases: ["ticketing holouly", "ticketingholouly", "تذكرة حلولي", "بلاغ حلولي"] },
  { header: "INCIDENT NUMBER", field: "incidentNumber", aliases: ["incident number", "incidentnumber", "incident", "رقم البلاغ", "رقم التذكرة"] },
  { header: "Pin Code", field: "pinCode", aliases: ["pin code", "pincode", "رمز pin", "البين كود"] },
  { header: "TRSM", field: "trsm", aliases: ["trsm", "رمز trsm"] },
  { header: "TERMINAL ID", field: "terminalId", aliases: ["terminal id", "terminalid", "رقم الجهاز", "رقم النهاية", "ترمنال"] },
  { header: "SIM S/N", field: "simSn", aliases: ["sim s/n", "sim sn", "simsn", "سيريال الشريحة", "رقم الشريحة التسلسلي", "iccid"] },
  { header: "ID DATA", field: "idData", aliases: ["id data", "iddata", "بيانات الهوية"] },
  { header: "Vendor Type", field: "vendorType", aliases: ["vendor type", "vendortype", "المورد", "نوع المورد", "الشركة المصنعة", "المصنع"] },
  { header: "CITY", field: "city", aliases: ["city", "المدينة", "مدينة التوصيل", "المنطقة"] },
  { header: "CITY Tec", field: "cityTec", aliases: ["city tec", "citytec", "مدينة الفني", "إقليم الفني"] },
  { header: "إسم العميل", field: "customerName", aliases: ["إسم العميل", "اسم العميل", "العميل", "customer name", "customername", "customer", "اسم التاجر", "التاجر", "اسم المحل"] },
  { header: "RETAILER NAME", field: "retailerName", aliases: ["retailer name", "retailername", "retailer", "اسم النشاط", "الاسم التجاري", "اسم المتجر"] },
  { header: "عنوان", field: "addressAr", aliases: ["عنوان", "العنوان", "address", "addressar", "العنوان بالعربية", "عنوان التوصيل", "تفاصيل العنوان"] },
  { header: "ADDRESS", field: "addressEn", aliases: ["address", "addressen", "العنوان بالإنجليزية"] },
  { header: "Mobile", field: "mobile", aliases: ["mobile", "الجوال", "رقم الجوال", "phone", "mobile number", "رقم الهاتف", "هاتف"] },
  { header: "Mobile2", field: "mobile2", aliases: ["mobile2", "جوال2", "الجوال2", "رقم جوال بديل", "mobile 2", "phone 2", "هاتف 2"] },
  { header: "Tec Name", field: "tecName", aliases: ["tec name", "tecname", "اسم الفني", "الفني", "technician", "اسم المندوب", "اسم المندوب", "فني المبيعات"] },
  // === Execution / Field completion columns (auto-create execution if present) ===
  { header: "SN", field: "sn", aliases: ["sn", "s/n", "serial number", "serial", "رقم السيريال", "رقم التسلسل", "الرقم التسلسلي", "رقم الجهاز التسلسلي", "device sn", "pos sn", "device serial"] },
  { header: "SIM Serial", field: "simSerial", aliases: ["sim serial", "simserial", "sim iccid", "iccid full", "رقم شريحة البيانات", "سيريال الشريحة الكاملة", "sim number"] },
  { header: "Sales Technician", field: "salesTechnician", aliases: ["sales technician", "salestechnician", "sales tec", "فني المبيعات المنفذ", "اسم الفني المنفذ", "الفني المنفذ", "tec name sales"] },
  { header: "Technician code", field: "technicianCode", aliases: ["technician code", "techniciancode", "tec code", "كود الفني", "رمز الفني"] },
  { header: "Installation Status", field: "installationStatus", aliases: ["installation status", "installationstatus", "status", "الحالة", "حالة التركيب", "نتيجة التركيب"] },
  { header: "Delivery Date", field: "deliveryDate", aliases: ["delivery date", "deliverydate", "تاريخ التسليم", "تاريخ التركيب", "تاريخ الزيارة"] },
  { header: "Time", field: "time", aliases: ["time", "الوقت", "وقت التسليم", "وقت التركيب"] }
];

/**
 * ADR-002 — central cell-value adapter (the ONLY place ExcelJS cell shapes are
 * interpreted). Returns a domain-neutral value; no ExcelJS object ever reaches
 * the service layer. Enforces the approved security policy: formulas and error
 * cells are rejected, unknown objects are rejected (never String(object)).
 */
export function normalizeSpreadsheetCell(
  value: ExcelJS.CellValue,
): string | number | Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;

  const t = typeof value;
  if (t === "string" || t === "number") return value as string | number;
  // Boolean: no proven business use in imports — reject rather than silently
  // coerce to "true"/"false".
  if (t === "boolean") throw new SpreadsheetError("UNSUPPORTED_CELL_TYPE");

  if (t === "object") {
    const o = value as unknown as Record<string, unknown>;
    if ("formula" in o || "sharedFormula" in o) {
      throw new SpreadsheetError("SPREADSHEET_FORMULA_NOT_ALLOWED");
    }
    if ("error" in o) {
      // A literal error cell (not backed by a formula) is still not trustworthy.
      throw new SpreadsheetError("UNSUPPORTED_CELL_TYPE");
    }
    if ("richText" in o && Array.isArray(o.richText)) {
      // Plain text only; drop styling/metadata.
      return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    }
    if ("hyperlink" in o) {
      // Display text only; never surface the URL to business logic.
      return typeof o.text === "string" ? o.text : null;
    }
    throw new SpreadsheetError("UNSUPPORTED_CELL_TYPE");
  }

  throw new SpreadsheetError("UNSUPPORTED_CELL_TYPE");
}

/**
 * Lenient structural view of a raw cell, used ONLY for header detection and the
 * empty-row filter (must not throw — a formula in an unmapped column must not
 * abort the import). Mirrors the previous xlsx grid values closely enough for
 * these structural decisions; imported field values always go through the
 * strict normalizeSpreadsheetCell above.
 */
function structuralCellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "object") {
    const o = value as unknown as Record<string, unknown>;
    if ("result" in o) return o.result ?? null; // formula's cached result
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    }
    if ("hyperlink" in o) return typeof o.text === "string" ? o.text : null;
    return null; // error / unknown → treated as empty for structure only
  }
  return null;
}

/**
 * ADR-002 Commit 3 — reads the import workbook via ExcelJS (was xlsx).
 * Public shape unchanged (returns the same ImportSummary); rowNumber semantics
 * preserved exactly (post-empty-filter index + header offset). The function is
 * now async because ExcelJS has no synchronous buffer reader. Throws typed
 * SpreadsheetError for structural problems (invalid/empty/no worksheet) and for
 * policy violations (formula/error/unsupported cell in a mapped field).
 */
export async function parseRawDataWorkbook(buffer: Buffer): Promise<ImportSummary> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw new SpreadsheetError("INVALID_SPREADSHEET", {
      internalCause: err instanceof Error ? err.message : String(err),
    });
  }

  if (workbook.worksheets.length === 0) {
    throw new SpreadsheetError("EMPTY_WORKBOOK");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new SpreadsheetError("WORKSHEET_NOT_FOUND");
  }

  // Build a dense grid of raw cell values (1-based cols → 0-based array).
  const columnCount = sheet.columnCount;
  const grid: ExcelJS.CellValue[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const arr: ExcelJS.CellValue[] = [];
    for (let c = 1; c <= columnCount; c++) {
      arr.push(row.getCell(c).value);
    }
    grid[rowNumber - 1] = arr;
  });
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) grid[i] = new Array(columnCount).fill(null);
  }

  const headerRow = grid[0] ?? [];
  const normalizedHeaders = headerRow.map((cell) => normalizeHeader(structuralCellValue(cell)));

  const fieldToColumnIndex = new Map<string, number>();
  for (const col of RAW_IMPORT_COLUMNS) {
    const idx = normalizedHeaders.findIndex((h) => {
      const lower = h.toLowerCase();
      return lower === col.header.toLowerCase() || col.aliases.some((alias) => lower === alias.toLowerCase());
    });
    if (idx !== -1) fieldToColumnIndex.set(col.field, idx);
  }

  const dataRows = grid.slice(1).filter((row) =>
    row.some((cell) => {
      const v = structuralCellValue(cell);
      return v !== null && v !== "";
    }),
  );

  const imported: ImportRowResult[] = [];
  const rejected: ImportRowResult[] = [];

  dataRows.forEach((row, idx) => {
    const rowNumber = idx + 2; // preserve existing semantics: post-filter index + header
    const data: Record<string, string | null> = {};
    for (const col of RAW_IMPORT_COLUMNS) {
      const colIndex = fieldToColumnIndex.get(col.field);
      const rawCell = colIndex === undefined ? null : row[colIndex];
      let domainValue: string | number | Date | null;
      try {
        domainValue = normalizeSpreadsheetCell(rawCell);
      } catch (err) {
        if (err instanceof SpreadsheetError) {
          // Enrich with the offending location and re-throw (file-level reject).
          throw new SpreadsheetError(err.code, { row: rowNumber, column: col.header });
        }
        throw err;
      }
      data[col.field] =
        col.field === "date" ? toIsoDate(normalizeCell(domainValue)) : normalizeCell(domainValue);
    }

    if (!data.tid && !data.terminalId) {
      rejected.push({ rowNumber, data, error: "Missing TID and Terminal ID" });
      return;
    }
    imported.push({ rowNumber, data });
  });

  return { totalRows: dataRows.length, imported, rejected };
}

function fmtTime(t: string | null): string | null {
  if (!t) return t;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min}:00 ${ampm}`;
}

function fmtDate(d: string | null): string | null {
  if (!d) return d;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return d;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export const EXPORT_COLUMNS = [
  { header: "Date", get: (r: any) => fmtDate(r.date) },
  { header: "Installation type", get: (r: any) => r.installationType },
  { header: "SIM", get: (r: any) => r.sim },
  { header: "TID", get: (r: any) => r.tid },
  { header: "OTP", get: (r: any) => r.otp },
  { header: "TICKETING HOLOULY", get: (r: any) => r.ticketingHolouly },
  { header: "INCIDENT NUMBER", get: (r: any) => r.incidentNumber },
  { header: "Pin Code", get: (r: any) => r.pinCode },
  { header: "TRSM", get: (r: any) => r.trsm },
  { header: "TERMINAL ID", get: (r: any) => r.terminalId },
  { header: "SIM S/N", get: (r: any) => r.simSn },
  { header: "ID DATA", get: (r: any) => r.idData },
  { header: "Vendor Type", get: (r: any) => r.vendorType },
  { header: "CITY", get: (r: any) => r.city },
  { header: "CITY Tec", get: (r: any) => r.cityTec },
  { header: "إسم العميل", get: (r: any) => r.customerName },
  { header: "RETAILER NAME", get: (r: any) => r.retailerName },
  { header: "عنوان", get: (r: any) => r.addressAr },
  { header: "ADDRESS", get: (r: any) => r.addressEn },
  { header: "Mobile", get: (r: any) => r.mobile },
  { header: "Mobile2", get: (r: any) => r.mobile2 },
  { header: "Tec Name", get: (r: any) => r.tecName },
  { header: "Request Priority Level", get: (r: any) => r.execution?.requestPriorityLevel ?? null },
  { header: "Push Back", get: (r: any) => r.execution?.pushBack ?? null },
  { header: "Installation Status", get: (r: any) => r.execution?.installationStatus ?? null },
  { header: "Paper roll", get: (r: any) => r.execution?.paperRoll ?? null },
  { header: "Time", get: (r: any) => fmtTime(r.execution?.time ?? null) },
  { header: "Delivery Date", get: (r: any) => fmtDate(r.execution?.deliveryDate ?? null) },
  { header: "Response Date", get: (r: any) => fmtDate(r.execution?.responseDate ?? null) },
  { header: "SN", get: (r: any) => r.execution?.sn ?? null },
  { header: "SIM Serial", get: (r: any) => r.execution?.simSerial ?? null },
  { header: "SIM Type", get: (r: any) => r.execution?.simType ?? null },
  { header: "Customer Notes", get: (r: any) => r.execution?.customerNotes ?? null },
  { header: "#", get: (r: any) => r.execution?.extraField1 ?? null },
  { header: "#2", get: (r: any) => r.execution?.extraField2 ?? null },
  { header: "Sales Technician", get: (r: any) => r.execution?.salesTechnician ?? null },
  { header: "Technician code", get: (r: any) => r.execution?.technicianCode ?? null }
];

export async function buildExportWorkbook(rows: any[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "StockPro Operations";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Operations Report", {
    views: [{ state: "frozen", ySplit: 1 }]
  });

  sheet.columns = EXPORT_COLUMNS.map((col) => ({
    header: col.header,
    key: col.header,
    width: Math.max(col.header.length + 4, 14)
  }));

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF284B63" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  rows.forEach((row) => {
    const record: Record<string, string | number | null> = {};
    for (const col of EXPORT_COLUMNS) {
      record[col.header] = col.get(row);
    }
    sheet.addRow(record);
  });

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (rowNumber % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
      });
    }
  });

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export async function streamExportWorkbook(
  filePath: string,
  fetchBatch: (offset: number, limit: number) => Promise<any[]>
): Promise<void> {
  const workbookWriter = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
    useSharedStrings: true,
  });

  const sheet = workbookWriter.addWorksheet("Operations Report", {
    views: [{ state: "frozen", ySplit: 1 }]
  });

  sheet.columns = EXPORT_COLUMNS.map((col) => ({
    header: col.header,
    key: col.header,
    width: Math.max(col.header.length + 4, 14)
  }));

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF284B63" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  headerRow.commit();

  let offset = 0;
  const limit = 5000;
  let rowNumber = 2;

  while (true) {
    const rows = await fetchBatch(offset, limit);
    if (!rows || rows.length === 0) {
      break;
    }

    for (const rowData of rows) {
      const record: Record<string, string | number | null> = {};
      for (const col of EXPORT_COLUMNS) {
        record[col.header] = col.get(rowData);
      }

      const excelRow = sheet.addRow(record);
      if (rowNumber % 2 === 0) {
        excelRow.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
        });
      }
      excelRow.commit();
      rowNumber++;
    }

    offset += limit;
  }

  await sheet.commit();
  await workbookWriter.commit();
}

