import { db } from "@core/config/db";
import { AppError } from "@core/errors/AppError";
import { itemTypes, items } from "@shared/schema";
import { eq, inArray, or } from "drizzle-orm";

export interface RecognitionResult {
  itemTypeId: string;
  normalizedSerial: string; // The clean serial number to be stored in the DB
  rawBarcode: string;       // The original raw barcode
  isValid: boolean;
  category: string;
  nameAr: string;
  carrierName: string | null;
  error?: string;
}

export interface StoredSerialResolution {
  /** Canonical form that should be written to items.serialNumber */
  normalizedSerial: string;
  itemTypeId: string;
  carrierName: string | null;
  rawBarcode: string;
  category: string;
  nameAr: string;
}

/**
 * Central Serial Engine — normalize → identify → validate → lookup.
 * ALL serial I/O (scan, lookup, verification, closing, return, search) must go through this service.
 * Storage format is unchanged: alphabetic prefixes (NCC/NCD/SAS/SAW) are stripped; numeric SIM prefixes stay.
 */
export class SerialRecognitionService {
  /**
   * Normalize a raw barcode input by removing prefixes like "SN:", spaces, dashes, etc.
   */
  static normalizeRawBarcode(rawBarcode: string): string {
    if (!rawBarcode) return "";
    let cleaned = rawBarcode.trim().toUpperCase();
    // Remove common prefixes like SN:, S/N:, HW:, SERIAL:, BARCODE:
    cleaned = cleaned.replace(/^(SN|S\/N|HW|SERIAL|BARCODE)[:\-\s]*/i, "");
    // GS1 symbology identifiers sometimes prepended by hardware scanners
    cleaned = cleaned.replace(/^\]?(C1|c1)/, "");
    // Remove all whitespace, dashes, underscores, and dots
    cleaned = cleaned.replace(/[\s\-_.]/g, "");
    return cleaned;
  }

  /**
   * Common Saudi ICCID OCR / keypad typo: 99966… → 89966…
   * (ITU-T E.118 country/issuer blocks for KSA SIMs start with 89.)
   */
  static expandSaudiIccidTypoCandidates(cleaned: string): string[] {
    if (!cleaned) return [];
    const out: string[] = [];
    if (/^99966\d{13,14}$/.test(cleaned)) {
      out.push(`89966${cleaned.slice(5)}`);
    }
    return out;
  }

  /**
   * Resolve carrier name based on itemType ID/names
   */
  static resolveCarrierName(itemTypeId: string, nameEn: string, nameAr: string): string | null {
    const idLower = itemTypeId.toLowerCase();
    const nameEnLower = nameEn.toLowerCase();
    const nameArLower = nameAr.toLowerCase();

    if (idLower.includes("stc") || nameEnLower.includes("stc") || nameArLower.includes("stc") || nameArLower.includes("اتصالات")) {
      return "STC";
    }
    if (idLower.includes("mobily") || nameEnLower.includes("mobily") || nameArLower.includes("موبايلي")) {
      return "Mobily";
    }
    if (idLower.includes("zain") || nameEnLower.includes("zain") || nameArLower.includes("زين")) {
      return "Zain";
    }
    if (
      idLower.includes("lebara") ||
      nameEnLower.includes("lebara") ||
      nameEnLower.includes("libar") ||
      nameArLower.includes("ليبارا")
    ) {
      return "Lebara";
    }
    return null;
  }

  /**
   * Build every plausible DB-stored form for a scanned/typed serial.
   * Used by lookup / scan-out / guards so prefixed and stripped forms both resolve.
   */
  static async buildStoredSerialCandidates(
    rawBarcode: string,
    hintItemTypeId?: string,
    txClient: any = db
  ): Promise<string[]> {
    const cleaned = this.normalizeRawBarcode(rawBarcode);
    const candidates = new Set<string>();

    if (!cleaned) return [];

    // Candidate contract: when the Central Serial Engine can recognize the input,
    // its canonical storage form MUST be the first candidate. Consumers that
    // need one representative value must use this first candidate rather than
    // selecting by length or another heuristic (which can turn NCD123… into
    // its stripped legacy form 123…).
    let canonicalSerial: string | null = null;

    try {
      const recognition = await this.recognize(rawBarcode, hintItemTypeId, txClient);
      canonicalSerial = recognition.normalizedSerial;
    } catch {
      // Soft path: still strip known prefixes even when full validation fails.
      // Retry recognition with OCR-corrected ICCID when raw was 99966…
      for (const typoFix of this.expandSaudiIccidTypoCandidates(cleaned)) {
        try {
          const recognition = await this.recognize(typoFix, hintItemTypeId, txClient);
          canonicalSerial = recognition.normalizedSerial;
          break;
        } catch {
          // ignore
        }
      }
    }

    if (canonicalSerial) candidates.add(canonicalSerial);

    candidates.add(cleaned);
    const trimmed = rawBarcode.trim();
    if (trimmed) candidates.add(trimmed.toUpperCase());

    for (const typoFix of this.expandSaudiIccidTypoCandidates(cleaned)) {
      candidates.add(typoFix);
    }

    const allTypes = await txClient
      .select()
      .from(itemTypes)
      .where(eq(itemTypes.isActive, true));

    const serializedTypes = allTypes.filter(
      (t: typeof itemTypes.$inferSelect) => t.requiresSerial && t.serialPrefix
    );

    for (const type of serializedTypes) {
      const prefixes = String(type.serialPrefix)
        .split(",")
        .map((p: string) => p.trim().toUpperCase())
        .filter(Boolean);

      for (const prefix of prefixes) {
        const isAlphabetic = /^[A-Z]+$/.test(prefix);
        if (isAlphabetic && cleaned.startsWith(prefix) && cleaned.length > prefix.length) {
          candidates.add(cleaned.substring(prefix.length));
        }
      }
    }

    return Array.from(candidates).filter(Boolean);
  }

  /**
   * Canonical write-path normalizer. Throws if serial cannot be recognized.
   */
  static async normalizeForStorage(
    rawBarcode: string,
    hintItemTypeId?: string,
    txClient: any = db
  ): Promise<StoredSerialResolution> {
    const recognition = await this.recognize(rawBarcode, hintItemTypeId, txClient);
    return {
      normalizedSerial: recognition.normalizedSerial,
      itemTypeId: recognition.itemTypeId,
      carrierName: recognition.carrierName,
      rawBarcode: recognition.rawBarcode,
      category: recognition.category,
      nameAr: recognition.nameAr,
    };
  }

  /**
   * Find an items row by any equivalent serial form (prefixed or stored).
   */
  static async findItemBySerial(
    rawBarcode: string,
    txClient: any = db,
    hintItemTypeId?: string
  ): Promise<typeof items.$inferSelect | null> {
    const candidates = await this.buildStoredSerialCandidates(rawBarcode, hintItemTypeId, txClient);
    if (candidates.length === 0) return null;

    const [item] = await txClient
      .select()
      .from(items)
      .where(
        or(
          inArray(items.serialNumber, candidates),
          inArray(items.barcode, candidates)
        )
      )
      .limit(1);

    return item || null;
  }

  /**
   * Recognize and validate a raw barcode.
   * If a hintItemTypeId is provided, it prioritizes that type for matching/validation.
   */
  static async recognize(rawBarcode: string, hintItemTypeId?: string, txClient: any = db): Promise<RecognitionResult> {
    const cleaned = this.normalizeRawBarcode(rawBarcode);
    if (!cleaned) {
      throw new AppError("الرقم التسلسلي فارغ بعد التنظيف", 400);
    }

    // Fetch all active serialized item types from database
    let allTypes = await txClient
      .select()
      .from(itemTypes)
      .where(eq(itemTypes.isActive, true));

    // Ensure enterprise device types exist in DB automatically with correct specifications
    const hasA960 = allTypes.some((t: any) => t.id === 'a960');
    const hasI9100 = allTypes.some((t: any) => t.id === 'i9100');
    const hasI9000s = allTypes.some((t: any) => t.id === 'i9000s');

    if (!hasA960 || !hasI9100 || !hasI9000s) {
      try {
        if (!hasA960) {
          await txClient.insert(itemTypes).values({
            id: 'a960',
            nameAr: 'A960',
            nameEn: 'PAX A960',
            category: 'devices',
            unitsPerBox: 1,
            isActive: true,
            isVisible: true,
            sortOrder: 4,
            icon: '📱',
            color: '#6366F1',
            requiresSerial: true,
            serialPrefix: null,
            serialLength: 10,
            serialRegex: '^[0-9]{10}$',
            createdAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoNothing();
        }
        if (!hasI9100) {
          await txClient.insert(itemTypes).values({
            id: 'i9100',
            nameAr: 'I9100',
            nameEn: 'I9100',
            category: 'devices',
            unitsPerBox: 1,
            isActive: true,
            isVisible: true,
            sortOrder: 3,
            icon: '📱',
            color: '#8B5CF6',
            requiresSerial: true,
            serialPrefix: 'SAW',
            serialLength: 14,
            serialRegex: '^SAW[0-9]{11}$',
            createdAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoNothing();
        }
        if (!hasI9000s) {
          await txClient.insert(itemTypes).values({
            id: 'i9000s',
            nameAr: 'I9000S',
            nameEn: 'I9000S',
            category: 'devices',
            unitsPerBox: 1,
            isActive: true,
            isVisible: true,
            sortOrder: 2,
            icon: '📱',
            color: '#10B981',
            requiresSerial: true,
            serialPrefix: 'SAS',
            serialLength: 14,
            serialRegex: '^SAS[0-9]{11}$',
            createdAt: new Date(),
            updatedAt: new Date(),
          }).onConflictDoNothing();
        }
        allTypes = await txClient
          .select()
          .from(itemTypes)
          .where(eq(itemTypes.isActive, true));
      } catch (e) {
        // Safe fallback
      }
    }

    const serializedTypes = allTypes.filter((t: typeof itemTypes.$inferSelect) => t.requiresSerial);

    // Resolve matched item type
    let matchedType = hintItemTypeId
      ? serializedTypes.find((t: any) => t.id.toLowerCase() === hintItemTypeId.toLowerCase())
      : undefined;

    if (!matchedType) {
      if (/^SAW[0-9]{11}$/i.test(cleaned)) {
        matchedType = serializedTypes.find((t: any) => t.id === 'i9100');
      } else if (/^SAS[0-9]{11}$/i.test(cleaned)) {
        matchedType = serializedTypes.find((t: any) => t.id === 'i9000s');
      } else if (/^(NCD|NCC)[0-9]{9}$/i.test(cleaned)) {
        matchedType = serializedTypes.find((t: any) => t.id === 'n950');
      } else if (/^89966[0-9]{13,14}$/.test(cleaned)) {
        matchedType = serializedTypes.find((t: any) => t.id.startsWith('sim'));
      }
    }

    if (!matchedType) {
      for (const type of serializedTypes) {
        if (type.serialPrefix) {
          const prefixes = String(type.serialPrefix)
            .split(',')
            .map((p: string) => p.trim().toUpperCase())
            .filter(Boolean);
          if (prefixes.some((p: string) => cleaned.startsWith(p))) {
            matchedType = type;
            break;
          }
        } else if (type.serialLength && cleaned.length === type.serialLength) {
          if ((type.id === 'a960' || type.nameAr.includes('A960')) && /^[0-9]{10}$/.test(cleaned)) {
            matchedType = type;
            break;
          }
        }
      }
    }

    if (!matchedType) {
      for (const fixed of this.expandSaudiIccidTypoCandidates(cleaned)) {
        return this.recognize(fixed, hintItemTypeId, txClient);
      }
      throw new AppError(`لم يتم التعرف على نوع المنتج للباركود: ${rawBarcode}`, 400);
    }

    const type = matchedType;
    const typeId = type.id.toLowerCase();

    // Specific validation & exact error messages per Section 12 specifications
    if (typeId === 'i9100') {
      if (!cleaned.startsWith('SAW') || cleaned.length !== 14 || !/^SAW[0-9]{11}$/i.test(cleaned)) {
        throw new AppError('الرقم يجب أن يبدأ بـ SAW ويتكون من 14 خانة.', 400);
      }
    } else if (typeId === 'i9000s' || typeId.includes('i9000')) {
      if (!cleaned.startsWith('SAS') || cleaned.length !== 14 || !/^SAS[0-9]{11}$/i.test(cleaned)) {
        throw new AppError('الرقم يجب أن يبدأ بـ SAS ويتكون من 14 خانة.', 400);
      }
    } else if (typeId === 'a960') {
      if (cleaned.length !== 10 || !/^[0-9]{10}$/.test(cleaned)) {
        throw new AppError('الرقم التسلسلي يجب أن يتكون من 10 أرقام.', 400);
      }
    } else {
      if (type.serialLength && cleaned.length !== type.serialLength) {
        throw new AppError(
          `طول الرقم التسلسلي (${cleaned}) غير صحيح لـ ${type.nameAr}. الطول المطلوب: ${type.serialLength} أرقام.`,
          400
        );
      }
      if (type.serialRegex) {
        try {
          const regex = new RegExp(type.serialRegex, 'i');
          if (!regex.test(cleaned)) {
            throw new AppError(`الرقم التسلسلي ${rawBarcode} لا يطابق الصيغة المعتمدة لـ ${type.nameAr}`, 400);
          }
        } catch (e) {
          if (e instanceof AppError) throw e;
        }
      }
    }

    const carrierName = this.resolveCarrierName(type.id, type.nameEn, type.nameAr);

    // OPAQUE FULL SERIAL (SAW43310018885, SAS30810004647, 1180234360) PRESERVED 100%!
    return {
      itemTypeId: type.id,
      normalizedSerial: cleaned,
      rawBarcode,
      isValid: true,
      category: type.category,
      nameAr: type.nameAr,
      carrierName
    };
  }
}
