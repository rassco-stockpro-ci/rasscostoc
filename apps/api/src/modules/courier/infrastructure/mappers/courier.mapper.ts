import type {
  CourierRequest,
  CourierExecution,
  CourierRequestItem,
  CourierPdfReport,
  CourierExecutionAttempt,
} from "../../domain/courier.types";

export class CourierRequestMapper {
  static toDomain(row: any): CourierRequest {
    if (!row) return null as any;
    return {
      id: row.id,
      date: row.date ?? null,
      installationType: row.installationType ?? null,
      sim: row.sim ?? null,
      tid: row.tid ?? null,
      otp: row.otp ?? null,
      ticketingHolouly: row.ticketingHolouly ?? null,
      incidentNumber: row.incidentNumber ?? null,
      pinCode: row.pinCode ?? null,
      trsm: row.trsm ?? null,
      terminalId: row.terminalId ?? null,
      simSn: row.simSn ?? null,
      idData: row.idData ?? null,
      vendorType: row.vendorType ?? null,
      city: row.city ?? null,
      cityTec: row.cityTec ?? null,
      customerName: row.customerName ?? null,
      retailerName: row.retailerName ?? null,
      addressAr: row.addressAr ?? null,
      addressEn: row.addressEn ?? null,
      mobile: row.mobile ?? null,
      mobile2: row.mobile2 ?? null,
      tecName: row.tecName ?? null,
      createdBy: row.createdBy ?? null,
      regionId: row.regionId ?? null,
      createdAt: row.createdAt ? new Date(row.createdAt) : null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
      version: row.version ?? 1,
    };
  }

  // OPS-PERM-S0-B1-B.I1: toPersistence() is shared by BOTH insertRequest and
  // updateRequest. regionId IS included here on purpose (it is a legitimate,
  // server-computed domain field for create), but immutability-on-update is
  // NOT this mapper's job — the repository's updateRequest() explicitly
  // strips regionId from its input before ever calling this method, so this
  // whitelist entry can never be reached from the update path. Do not remove
  // that repository-level strip merely because this line exists.
  static toPersistence(domain: Partial<CourierRequest>): any {
    if (!domain) return null;
    const res: any = {};
    if (domain.id !== undefined) res.id = domain.id;
    if (domain.regionId !== undefined) res.regionId = domain.regionId;
    if (domain.date !== undefined) res.date = domain.date;
    if (domain.installationType !== undefined) res.installationType = domain.installationType;
    if (domain.sim !== undefined) res.sim = domain.sim;
    if (domain.tid !== undefined) res.tid = domain.tid;
    if (domain.otp !== undefined) res.otp = domain.otp;
    if (domain.ticketingHolouly !== undefined) res.ticketingHolouly = domain.ticketingHolouly;
    if (domain.incidentNumber !== undefined) res.incidentNumber = domain.incidentNumber;
    if (domain.pinCode !== undefined) res.pinCode = domain.pinCode;
    if (domain.trsm !== undefined) res.trsm = domain.trsm;
    if (domain.terminalId !== undefined) res.terminalId = domain.terminalId;
    if (domain.simSn !== undefined) res.simSn = domain.simSn;
    if (domain.idData !== undefined) res.idData = domain.idData;
    if (domain.vendorType !== undefined) res.vendorType = domain.vendorType;
    if (domain.city !== undefined) res.city = domain.city;
    if (domain.cityTec !== undefined) res.cityTec = domain.cityTec;
    if (domain.customerName !== undefined) res.customerName = domain.customerName;
    if (domain.retailerName !== undefined) res.retailerName = domain.retailerName;
    if (domain.addressAr !== undefined) res.addressAr = domain.addressAr;
    if (domain.addressEn !== undefined) res.addressEn = domain.addressEn;
    if (domain.mobile !== undefined) res.mobile = domain.mobile;
    if (domain.mobile2 !== undefined) res.mobile2 = domain.mobile2;
    if (domain.tecName !== undefined) res.tecName = domain.tecName;
    if (domain.createdBy !== undefined) res.createdBy = domain.createdBy;
    if (domain.createdAt !== undefined) res.createdAt = domain.createdAt;
    if (domain.updatedAt !== undefined) res.updatedAt = domain.updatedAt;
    if (domain.version !== undefined) res.version = domain.version;
    return res;
  }
}

export class CourierRequestItemMapper {
  static toDomain(row: any): CourierRequestItem {
    if (!row) return null as any;
    return {
      id: row.id,
      requestId: row.requestId,
      itemType: row.itemType,
      inventoryItemId: row.inventoryItemId ?? null,
      itemId: row.itemId ?? null,
      serialNumber: row.serialNumber ?? null,
      simSerial: row.simSerial ?? null,
      quantity: row.quantity ?? 1,
      status: row.status,
      scannedAt: row.scannedAt ? new Date(row.scannedAt) : null,
      receivedAt: row.receivedAt ? new Date(row.receivedAt) : null,
      installedAt: row.installedAt ? new Date(row.installedAt) : null,
      deliveredAt: row.deliveredAt ? new Date(row.deliveredAt) : null,
      technicianId: row.technicianId ?? null,
      executionUnitId: row.executionUnitId ?? null,
      createdAt: row.createdAt ? new Date(row.createdAt) : null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
    };
  }

  static toPersistence(domain: Partial<CourierRequestItem>): any {
    if (!domain) return null;
    const res: any = {};
    if (domain.id !== undefined) res.id = domain.id;
    if (domain.requestId !== undefined) res.requestId = domain.requestId;
    if (domain.itemType !== undefined) res.itemType = domain.itemType;
    if (domain.inventoryItemId !== undefined) res.inventoryItemId = domain.inventoryItemId;
    if (domain.itemId !== undefined) res.itemId = domain.itemId;
    if (domain.executionUnitId !== undefined) res.executionUnitId = domain.executionUnitId;
    if (domain.serialNumber !== undefined) res.serialNumber = domain.serialNumber;
    if (domain.simSerial !== undefined) res.simSerial = domain.simSerial;
    if (domain.quantity !== undefined) res.quantity = domain.quantity;
    if (domain.status !== undefined) res.status = domain.status;
    if (domain.scannedAt !== undefined) res.scannedAt = domain.scannedAt;
    if (domain.receivedAt !== undefined) res.receivedAt = domain.receivedAt;
    if (domain.installedAt !== undefined) res.installedAt = domain.installedAt;
    if (domain.deliveredAt !== undefined) res.deliveredAt = domain.deliveredAt;
    if (domain.technicianId !== undefined) res.technicianId = domain.technicianId;
    if (domain.createdAt !== undefined) res.createdAt = domain.createdAt;
    if (domain.updatedAt !== undefined) res.updatedAt = domain.updatedAt;
    return res;
  }
}

export class CourierExecutionMapper {
  static toDomain(row: any): CourierExecution {
    if (!row) return null as any;
    return {
      id: row.id,
      requestId: row.requestId,
      requestPriorityLevel: row.requestPriorityLevel ?? null,
      pushBack: row.pushBack ?? null,
      installationStatus: row.installationStatus ?? null,
      paperRoll: row.paperRoll ?? null,
      paperRollQty: row.paperRollQty ?? row.paper_roll_qty ?? 0,
      stickersQty: row.stickersQty ?? row.stickers_qty ?? 0,
      nulipCardsQty: row.nulipCardsQty ?? row.nulip_cards_qty ?? 0,
      time: row.time ?? null,
      deliveryDate: row.deliveryDate ?? null,
      responseDate: row.responseDate ?? null,
      sn: row.sn ?? null,
      simSerial: row.simSerial ?? null,
      simType: row.simType ?? null,
      customerNotes: row.customerNotes ?? null,
      extraField1: row.extraField1 ?? null,
      extraField2: row.extraField2 ?? null,
      responseReasonCode: row.responseReasonCode ?? null,
      salesTechnician: row.salesTechnician ?? null,
      technicianCode: row.technicianCode ?? null,
      extractionConfidence: row.extractionConfidence ?? null,
      enteredBy: row.enteredBy ?? null,
      enteredAt: row.enteredAt ? new Date(row.enteredAt) : null,
      updatedAt: row.updatedAt ? new Date(row.updatedAt) : null,
      version: row.version ?? 1,
      // OPS-REMED-E4-P2: `?? null`, not left undefined — the column is a
      // real, already-migrated (P1) nullable field; a row that has never
      // been written by P2 code has a real `NULL` in the database, and
      // that must survive round-tripping as `null`, not be coerced away.
      custodyClosureStatus: row.custodyClosureStatus ?? null,
    };
  }

  static toPersistence(domain: Partial<CourierExecution>): any {
    if (!domain) return null;
    const res: any = {};
    if (domain.id !== undefined) res.id = domain.id;
    if (domain.requestId !== undefined) res.requestId = domain.requestId;
    if (domain.requestPriorityLevel !== undefined) res.requestPriorityLevel = domain.requestPriorityLevel;
    if (domain.pushBack !== undefined) res.pushBack = domain.pushBack;
    if (domain.installationStatus !== undefined) res.installationStatus = domain.installationStatus;
    if (domain.paperRoll !== undefined) res.paperRoll = domain.paperRoll;
    if (domain.paperRollQty !== undefined) res.paperRollQty = domain.paperRollQty;
    if (domain.stickersQty !== undefined) res.stickersQty = domain.stickersQty;
    if (domain.nulipCardsQty !== undefined) res.nulipCardsQty = domain.nulipCardsQty;
    if (domain.time !== undefined) res.time = domain.time;
    if (domain.deliveryDate !== undefined) res.deliveryDate = domain.deliveryDate;
    if (domain.responseDate !== undefined) res.responseDate = domain.responseDate;
    if (domain.sn !== undefined) res.sn = domain.sn;
    if (domain.simSerial !== undefined) res.simSerial = domain.simSerial;
    if (domain.simType !== undefined) res.simType = domain.simType;
    if (domain.customerNotes !== undefined) res.customerNotes = domain.customerNotes;
    if (domain.extraField1 !== undefined) res.extraField1 = domain.extraField1;
    if (domain.extraField2 !== undefined) res.extraField2 = domain.extraField2;
    if (domain.responseReasonCode !== undefined) res.responseReasonCode = domain.responseReasonCode;
    if (domain.salesTechnician !== undefined) res.salesTechnician = domain.salesTechnician;
    if (domain.technicianCode !== undefined) res.technicianCode = domain.technicianCode;
    if (domain.extractionConfidence !== undefined) res.extractionConfidence = domain.extractionConfidence;
    if (domain.enteredBy !== undefined) res.enteredBy = domain.enteredBy;
    if (domain.enteredAt !== undefined) res.enteredAt = domain.enteredAt;
    if (domain.updatedAt !== undefined) res.updatedAt = domain.updatedAt;
    if (domain.version !== undefined) res.version = domain.version;
    // OPS-REMED-E4-P2: `undefined` stays omitted (preserves the existing
    // whitelist contract exactly — a caller that never mentions the field
    // does not accidentally clear it); an explicit `null` is passed through
    // so a deliberate reset is possible; any real state string is passed
    // through unchanged. No default is invented here.
    if (domain.custodyClosureStatus !== undefined) res.custodyClosureStatus = domain.custodyClosureStatus;
    return res;
  }
}

export class CourierPdfReportMapper {
  static toDomain(row: any): CourierPdfReport {
    if (!row) return null as any;
    return {
      id: row.id,
      requestId: row.requestId ?? null,
      fileName: row.fileName,
      filePath: row.filePath,
      uploadedBy: row.uploadedBy ?? null,
      uploadedAt: row.uploadedAt ? new Date(row.uploadedAt) : null,
      ocrText: row.ocrText ?? null,
      extractedJson: row.extractedJson ?? null,
      overallConfidence: row.overallConfidence ?? null,
      status: row.status,
      uploadedByName: row.uploadedByName ?? null,
      uploadedByTechnicianCode: row.uploadedByTechnicianCode ?? null,
      uploadedByRegionId: row.uploadedByRegionId ?? null,
      uploadedByRegionName: row.uploadedByRegionName ?? null,
      requestRetailerName: row.requestRetailerName ?? null,
      requestMobile: row.requestMobile ?? null,
      requestMobile2: row.requestMobile2 ?? null,
      requestTid: row.requestTid ?? null,
      requestTerminalId: row.requestTerminalId ?? null,
      requestCustomerName: row.requestCustomerName ?? null,
      requestCity: row.requestCity ?? null,
      requestAddressAr: row.requestAddressAr ?? null,
      requestInstallationType: row.requestInstallationType ?? null,
      requestVendorType: row.requestVendorType ?? null,
      requestTecName: row.requestTecName ?? null,
      requestDate: row.requestDate ?? null,
    };
  }

  static toPersistence(domain: Partial<CourierPdfReport>): any {
    if (!domain) return null;
    const res: any = {};
    if (domain.id !== undefined) res.id = domain.id;
    if (domain.requestId !== undefined) res.requestId = domain.requestId;
    if (domain.fileName !== undefined) res.fileName = domain.fileName;
    if (domain.filePath !== undefined) res.filePath = domain.filePath;
    if (domain.uploadedBy !== undefined) res.uploadedBy = domain.uploadedBy;
    if (domain.uploadedAt !== undefined) res.uploadedAt = domain.uploadedAt;
    if (domain.ocrText !== undefined) res.ocrText = domain.ocrText;
    if (domain.extractedJson !== undefined) res.extractedJson = domain.extractedJson;
    if (domain.overallConfidence !== undefined) res.overallConfidence = domain.overallConfidence;
    if (domain.status !== undefined) res.status = domain.status;
    return res;
  }
}

export class CourierExecutionAttemptMapper {
  static toDomain(row: any): CourierExecutionAttempt {
    if (!row) return null as any;
    return {
      id: row.id,
      requestId: row.requestId,
      attemptNumber: row.attemptNumber ?? 1,
      status: row.status,
      failureReasonCode: row.failureReasonCode ?? null,
      notes: row.notes ?? null,
      snInstalled: row.snInstalled ?? null,
      simInstalled: row.simInstalled ?? null,
      gpsLatitude: row.gpsLatitude ?? null,
      gpsLongitude: row.gpsLongitude ?? null,
      batteryLevel: row.batteryLevel ?? null,
      networkOperator: row.networkOperator ?? null,
      startTime: row.startTime ? new Date(row.startTime) : null,
      arrivalTime: row.arrivalTime ? new Date(row.arrivalTime) : null,
      endTime: row.endTime ? new Date(row.endTime) : null,
      evidencePhotos: row.evidencePhotos ?? null,
      customerSignature: row.customerSignature ?? null,
      enteredBy: row.enteredBy ?? null,
      createdAt: row.createdAt ? new Date(row.createdAt) : null,
    };
  }

  static toPersistence(domain: Partial<CourierExecutionAttempt>): any {
    if (!domain) return null;
    const res: any = {};
    if (domain.id !== undefined) res.id = domain.id;
    if (domain.requestId !== undefined) res.requestId = domain.requestId;
    if (domain.attemptNumber !== undefined) res.attemptNumber = domain.attemptNumber;
    if (domain.status !== undefined) res.status = domain.status;
    if (domain.failureReasonCode !== undefined) res.failureReasonCode = domain.failureReasonCode;
    if (domain.notes !== undefined) res.notes = domain.notes;
    if (domain.snInstalled !== undefined) res.snInstalled = domain.snInstalled;
    if (domain.simInstalled !== undefined) res.simInstalled = domain.simInstalled;
    if (domain.gpsLatitude !== undefined) res.gpsLatitude = domain.gpsLatitude;
    if (domain.gpsLongitude !== undefined) res.gpsLongitude = domain.gpsLongitude;
    if (domain.batteryLevel !== undefined) res.batteryLevel = domain.batteryLevel;
    if (domain.networkOperator !== undefined) res.networkOperator = domain.networkOperator;
    if (domain.startTime !== undefined) res.startTime = domain.startTime;
    if (domain.arrivalTime !== undefined) res.arrivalTime = domain.arrivalTime;
    if (domain.endTime !== undefined) res.endTime = domain.endTime;
    if (domain.evidencePhotos !== undefined) res.evidencePhotos = domain.evidencePhotos;
    if (domain.customerSignature !== undefined) res.customerSignature = domain.customerSignature;
    if (domain.enteredBy !== undefined) res.enteredBy = domain.enteredBy;
    if (domain.createdAt !== undefined) res.createdAt = domain.createdAt;
    return res;
  }
}
