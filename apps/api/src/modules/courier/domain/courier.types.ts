/**
 * Courier Domain Shared Types
 *
 * Defines types that are shared across Domain, Application, and Infrastructure
 * layers within the Courier module. These types must NOT depend on any framework,
 * ORM, or infrastructure concern.
 */

export interface ListFilters {
  q?: string;
  city?: string;
  technician?: string;
  status?: string;
  reason?: string;
  simType?: string;
  vendor?: string;
  priority?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
  /** When false, skip COUNT(*) (total ≈ page row count). Default true. */
  includeTotal?: boolean;
}

export interface ItemUpdatePayload {
  itemId: number;
  status: string;
  serialNumber?: string;
  simSerial?: string;
}

/**
 * Assignment Writer lock snapshots.
 *
 * These carry only the fields assignment authorization policy needs — never
 * a raw ORM row — so the application layer never depends on a Drizzle type.
 * Each is produced by a repository method whose name says explicitly that it
 * acquires a transaction-scoped row lock (see ICourierRequestsRepository);
 * none of these values may be trusted unless they were read inside the same
 * transaction as the eventual assignment write.
 */
export interface AssignmentUserSnapshot {
  id: string;
  role: string;
  regionId: string | null;
  isActive: boolean;
}

export interface AssignmentRegionSnapshot {
  id: string;
  isActive: boolean;
}

export interface AssignmentRequestSnapshot {
  id: number;
  regionId: string | null;
  assignedToUserId: string | null;
  version: number;
}

/** Snapshot of the serial lookup result returned by the serial engine. */
export interface SerialLookupResult {
  found: boolean;
  serial: string;
  normalized: string;
  item: {
    id: string;
    serialNumber: string | null;
    status: string;
    barcode: string | null;
  } | null;
  itemType: {
    id: string;
    nameAr: string;
    category: string;
    carrierName: string | null;
  } | null;
  technician: {
    id: string;
    fullName: string;
    username: string;
    technicianCode: string | null;
  } | null;
  custodyStatus: string | null;
  inActiveCustody: boolean;
  linkedRequest: {
    requestId: number;
    tid: string | null;
    terminalId: string | null;
    customerName: string | null;
    installationType: string | null;
    itemStatus: string;
  } | null;
  ownershipValid: boolean;
  message?: string;
}

export interface CourierRequest {
  id: number;
  date: string | null;
  installationType: string | null;
  sim: string | null;
  tid: string | null;
  otp: string | null;
  ticketingHolouly: string | null;
  incidentNumber: string | null;
  pinCode: string | null;
  trsm: string | null;
  terminalId: string | null;
  simSn: string | null;
  idData: string | null;
  vendorType: string | null;
  city: string | null;
  cityTec: string | null;
  customerName: string | null;
  retailerName: string | null;
  addressAr: string | null;
  addressEn: string | null;
  mobile: string | null;
  mobile2: string | null;
  tecName: string | null;
  createdBy: string | null;
  // OPS-PERM-S0-B1-B.I1: canonical regional ownership. Only ever set by the
  // server-side region-assignment contract in courier.service.ts — never
  // trust this value if it originates from a client-supplied object.
  regionId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  version: number;
}

export interface CourierRequestItem {
  id: number;
  requestId: number;
  itemType: string;
  inventoryItemId: number | null;
  /** The inventory item this row stands for (replaces the dead inventoryItemId). */
  itemId: string | null;
  serialNumber: string | null;
  simSerial: string | null;
  quantity: number;
  status: string;
  scannedAt: Date | null;
  receivedAt: Date | null;
  installedAt: Date | null;
  deliveredAt: Date | null;
  technicianId: string | null;
  /** The installation unit this item was installed in (set together with INSTALLED). */
  executionUnitId: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** One installed terminal of a close: one device, at most one SIM, optional TID. */
export interface CourierExecutionUnit {
  id: number;
  requestId: number;
  executionId: number;
  unitNo: number;
  deviceItemId: string;
  deviceSerial: string;
  simItemId: string | null;
  simSerial: string | null;
  simWaived: boolean;
  tid: string | null;
  pairingSource: "EXPLICIT" | "LEGACY_INFERRED" | "LEGACY_BACKFILL";
  createdAt: Date | null;
}

export interface CourierExecution {
  id: number;
  requestId: number;
  requestPriorityLevel: string | null;
  pushBack: string | null;
  installationStatus: string | null;
  paperRoll: string | null;
  paperRollQty?: number | null;
  stickersQty?: number | null;
  nulipCardsQty?: number | null;
  time: string | null;
  deliveryDate: string | null;
  responseDate: string | null;
  sn: string | null;
  simSerial: string | null;
  simType: string | null;
  customerNotes: string | null;
  extraField1: string | null;
  extraField2: string | null;
  responseReasonCode: string | null;
  salesTechnician: string | null;
  technicianCode: string | null;
  extractionConfidence: string | null;
  enteredBy: string | null;
  enteredAt: Date | null;
  updatedAt: Date | null;
  version: number;
  /**
   * OPS-REMED-E4-P2: expand-phase (P1) nullable projection column, added to
   * the domain type now that P2 writers exist. Kept as `string | null` (not
   * a union of literal states) — the database has no CHECK constraint yet
   * (P4).
   */
  custodyClosureStatus: string | null;
}

export interface CourierPdfReport {
  id: number;
  requestId: number | null;
  fileName: string;
  filePath: string;
  uploadedBy: string | null;
  uploadedAt: Date | null;
  ocrText: string | null;
  extractedJson: string | null;
  overallConfidence: number | null;
  status: string;
  // إثراء اختياري لعرض/فلترة صفحة courier/pdf الإدارية - يُملأ فقط عبر listPdfReports/
  // findPdfReportById (ربط users/regions/courierRequests)، وليس جزءًا من الجدول نفسه
  uploadedByName?: string | null;
  uploadedByTechnicianCode?: string | null;
  uploadedByRegionId?: string | null;
  uploadedByRegionName?: string | null;
  // بيانات الطلب المرتبط (بيانات العميل الكاملة)
  requestRetailerName?: string | null;
  requestMobile?: string | null;
  requestMobile2?: string | null;
  requestTid?: string | null;
  requestTerminalId?: string | null;
  requestCustomerName?: string | null;
  requestCity?: string | null;
  requestAddressAr?: string | null;
  requestInstallationType?: string | null;
  requestVendorType?: string | null;
  requestTecName?: string | null;
  requestDate?: string | null;
}

export interface PdfReportFilters {
  region?: string;
  technician?: string;
  q?: string;
}

export interface CourierExecutionAttempt {
  id: number;
  requestId: number;
  attemptNumber: number;
  status: string;
  failureReasonCode: string | null;
  notes: string | null;
  snInstalled: string | null;
  simInstalled: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  batteryLevel: number | null;
  networkOperator: string | null;
  startTime: Date | null;
  arrivalTime: Date | null;
  endTime: Date | null;
  evidencePhotos: any | null; // string[] as JSON/array
  customerSignature: string | null;
  enteredBy: string | null;
  createdAt: Date | null;
}
