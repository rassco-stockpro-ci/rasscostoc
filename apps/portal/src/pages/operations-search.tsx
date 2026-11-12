import { useTranslation, t } from "@/lib/language";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useActiveItemTypes } from "@/hooks/use-item-types";
import {
  CheckCircle2,
  Download,
  History,
  Package,
  Search,
  Smartphone,
  TriangleAlert,
  XCircle,
} from "lucide-react";

type ReceivedDevice = {
  id: string;
  terminalId: string;
  serialNumber: string;
  itemTypeId: string | null;
  status: "pending" | "approved" | "rejected";
  adminNotes: string | null;
  createdAt: string | Date;
  updatedAt: string | Date | null;
  technicianId: string;
};

type WithdrawnDevice = {
  id: string;
  city: string;
  technicianName: string;
  terminalId: string;
  serialNumber: string;
  notes: string | null;
  damagePart: string | null;
  createdAt: string | Date | null;
  updatedAt: string | Date | null;
};

type WarehouseTransfer = {
  id: string;
  warehouseId: string;
  technicianId: string;
  itemType: string;
  packagingType: string;
  quantity: number;
  performedBy: string;
  notes?: string;
  status: "pending" | "accepted" | "rejected";
  rejectionReason?: string;
  respondedAt?: Date | string;
  createdAt: Date | string;
  warehouseName?: string;
  technicianName?: string;
};

type TimelineEntry = {
  id: string;
  title: string;
  description: string;
  timestamp: string | Date;
  markerClass: string;
  tags?: string[];
};

type SerializedItemSearchResult = {
  id: string;
  serialNumber: string;
  barcode: string | null;
  status: string;
  createdAt: string | Date;
  itemTypeId: string | null;
  itemTypeNameAr: string | null;
  itemTypeNameEn: string | null;
  ownerName: string | null;
  ownerUsername: string | null;
  currentOwnerId: string | null;
};

type SearchResultItem = {
  id: string;
  source: "withdrawn" | "received" | "warehouse-transfer";
  sourceLabel: string;
  title: string;
  operationNumber: string;
  operationRefs: string[];
  serialNumber: string;
  productName: string;
  statusText: string;
  statusClass: string;
  createdAt: string | Date;
  route: string;
  summary: string;
  searchable: string[];
  exactTokens: string[];
  timeline: TimelineEntry[];
};

const normalizeText = (value?: string | null): string => (value || "").trim().toLowerCase();

const formatDate = (value?: string | Date | null): string => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("ar-SA", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
};

const formatDateTime = (value?: string | Date | null): string => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("ar-SA", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getReadableOperationNumber = (prefix: "WD" | "RC" | "OP", id: string): string => {
  const shortId = (id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
  return `${prefix}-${shortId || "UNKNOWN"}`;
};

const inferWithdrawnStatus = (device: WithdrawnDevice): "pending" | "approved" | "rejected" | "maintenance" => {
  const combined = `${normalizeText(device.notes)} ${normalizeText(device.damagePart)}`;

  if (/(صيانة|maintenance|تحويل\s*للصيانة)/i.test(combined)) return "maintenance";
  if (/(مرفوض|رفض|rejected|reject)/i.test(combined)) return "rejected";
  if (/(موافق|تمت\s*الموافقة|approved|accept|مقبول)/i.test(combined)) return "approved";

  return "pending";
};

const withdrawnStatusUi: Record<
  ReturnType<typeof inferWithdrawnStatus>,
  { text: string; className: string; markerClass: string }
> = {
  pending: {
    text: t('common.pending_review'),
    className: "bg-amber-50 border border-amber-200 text-amber-700",
    markerClass: "bg-amber-500",
  },
  approved: {
    text: t('common.ok'),
    className: "bg-emerald-50 border border-emerald-200 text-emerald-700",
    markerClass: "bg-emerald-500",
  },
  rejected: {
    text: t('common.item_9566'),
    className: "bg-rose-50 border border-rose-200 text-rose-700",
    markerClass: "bg-rose-500",
  },
  maintenance: {
    text: t('common.item_19172'),
    className: "bg-orange-50 border border-orange-200 text-orange-700",
    markerClass: "bg-orange-500",
  },
};

const receivedStatusUi: Record<
  ReceivedDevice["status"],
  { text: string; className: string; markerClass: string }
> = {
  pending: {
    text: t('common.pending_review'),
    className: "bg-amber-50 border border-amber-200 text-amber-700",
    markerClass: "bg-amber-500",
  },
  approved: {
    text: t('common.ok_1'),
    className: "bg-emerald-50 border border-emerald-200 text-emerald-700",
    markerClass: "bg-emerald-500",
  },
  rejected: {
    text: t('common.rejected'),
    className: "bg-rose-50 border border-rose-200 text-rose-700",
    markerClass: "bg-rose-500",
  },
};

const transferStatusUi: Record<
  "accepted" | "rejected",
  { text: string; className: string; markerClass: string }
> = {
  accepted: {
    text: t('common.completed'),
    className: "bg-emerald-50 border border-emerald-200 text-emerald-700",
    markerClass: "bg-emerald-500",
  },
  rejected: {
    text: t('common.rejected'),
    className: "bg-rose-50 border border-rose-200 text-rose-700",
    markerClass: "bg-rose-500",
  },
};

function normalizeTransferStatus(status?: string | null): "accepted" | "rejected" | "pending" {
  const normalized = normalizeText(status);

  if (normalized === "rejected" || normalized === "reject" || normalized === "declined") {
    return "rejected";
  }

  if (
    normalized === "accepted" ||
    normalized === "approved" ||
    normalized === "approve" ||
    normalized === "completed" ||
    normalized === "done"
  ) {
    return "accepted";
  }

  return "pending";
}

function getTransferGroupId(transfer: WarehouseTransfer): string {
  const date = new Date(transfer.createdAt);
  const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  return `${transfer.warehouseId}-${dayKey}-${transfer.performedBy}-${transfer.status}-${transfer.notes || "no-notes"}`;
}

function rankSearchResults(results: SearchResultItem[], query: string): SearchResultItem[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  return results
    .map((result) => {
      const searchable = result.searchable.map((entry) => normalizeText(entry));
      const exact = result.exactTokens.some((entry) => normalizeText(entry) === normalizedQuery);
      const startsWith = searchable.some((entry) => entry.startsWith(normalizedQuery));
      const includes = searchable.some((entry) => entry.includes(normalizedQuery));

      if (!exact && !startsWith && !includes) return null;

      let score = 0;
      if (exact) score += 1000;
      if (startsWith) score += 650;
      if (includes) score += 350;
      if (normalizeText(result.serialNumber) === normalizedQuery) score += 120;
      if (normalizeText(result.operationNumber) === normalizedQuery) score += 100;
      if (normalizeText(result.productName).includes(normalizedQuery)) score += 40;

      return { result, score };
    })
    .filter((entry): entry is { result: SearchResultItem; score: number } => !!entry)
    .sort((first, second) => {
      if (second.score !== first.score) {
        return second.score - first.score;
      }
      return new Date(second.result.createdAt).getTime() - new Date(first.result.createdAt).getTime();
    })
    .map((entry) => entry.result);
}

export default function OperationsSearchPage() {
  const { t, dir } = useTranslation();
  const [, setLocation] = useLocation();

  const [searchInput, setSearchInput] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);

  const {
    data: receivedDevices = [],
    isLoading: isLoadingReceived,
    error: receivedError,
  } = useQuery<ReceivedDevice[]>({
    queryKey: ["/api/received-devices"],
  });

  const {
    data: withdrawnDevices = [],
    isLoading: isLoadingWithdrawn,
    error: withdrawnError,
  } = useQuery<WithdrawnDevice[]>({
    queryKey: ["/api/withdrawn-devices"],
  });

  const {
    data: transfers = [],
    isLoading: isLoadingTransfers,
    error: transfersError,
  } = useQuery<WarehouseTransfer[]>({
    queryKey: ["/api/warehouse-transfers"],
  });

  const {
    data: itemTypes = [],
    isLoading: isLoadingItemTypes,
  } = useActiveItemTypes();

  const {
    data: serializedItemMatches = [],
    isLoading: isLoadingSerializedItems,
    error: serializedItemsError,
  } = useQuery<SerializedItemSearchResult[]>({
    queryKey: [`/api/serialized-items/search?q=${encodeURIComponent(submittedQuery)}`],
    enabled: !!submittedQuery,
  });

  const itemTypeMap = useMemo(() => {
    const map = new Map<string, { nameAr: string; nameEn: string }>();
    itemTypes.forEach((itemType) => {
      map.set(itemType.id, { nameAr: itemType.nameAr, nameEn: itemType.nameEn });
      map.set(itemType.nameEn, { nameAr: itemType.nameAr, nameEn: itemType.nameEn });
    });
    return map;
  }, [itemTypes]);

  const allResults = useMemo(() => {
    const results: SearchResultItem[] = [];

    withdrawnDevices.forEach((device) => {
      const status = inferWithdrawnStatus(device);
      const statusUi = withdrawnStatusUi[status];
      const operationNumber = getReadableOperationNumber("WD", device.id);

      const timeline: TimelineEntry[] = [
        {
          id: `wd-create-${device.id}`,
          title: t('common.device_returned'),
          description: t('common.completed_device_system', { var_0: device.serialNumber }),
          timestamp: device.createdAt || new Date(),
          markerClass: "bg-cyan-400",
          tags: [
            t('common.city_3', { var_0: device.city || t('common.item_11173') }),
            t('common.technician_8', { var_0: device.technicianName || t('common.item_11173') }),
          ],
        },
      ];

      if (device.updatedAt) {
        timeline.push({
          id: `wd-status-${device.id}`,
          title: t('common.status_9', { var_0: statusUi.text }),
          description: device.notes || t('common.completed_update_data_request'),
          timestamp: device.updatedAt,
          markerClass: statusUi.markerClass,
        });
      }

      results.push({
        id: `withdrawn-${device.id}`,
        source: "withdrawn",
        sourceLabel: t('common.returned'),
        title: t('common.returned_1', { var_0: device.terminalId || t('common.device') }),
        operationNumber,
        operationRefs: [device.id],
        serialNumber: device.serialNumber,
        productName: device.terminalId,
        statusText: statusUi.text,
        statusClass: statusUi.className,
        createdAt: device.createdAt || new Date(),
        route: `/withdrawn-devices/${device.id}`,
        summary: device.notes || t('common.request_returned_followup'),
        searchable: [
          device.serialNumber,
          device.id,
          operationNumber,
          device.terminalId,
          device.technicianName,
          device.city,
          device.notes || "",
        ],
        exactTokens: [device.serialNumber, device.id, operationNumber],
        timeline,
      });
    });

    receivedDevices.forEach((device) => {
      const statusUi = receivedStatusUi[device.status];
      const operationNumber = getReadableOperationNumber("RC", device.id);
      const itemTypeLabel =
        (device.itemTypeId && itemTypeMap.get(device.itemTypeId)?.nameAr) ||
        (device.itemTypeId && itemTypeMap.get(device.itemTypeId)?.nameEn) ||
        device.terminalId;

      const timeline: TimelineEntry[] = [
        {
          id: `rc-create-${device.id}`,
          title: t('common.receive_device_system'),
          description: t('common.completed_receive_device_technician', { var_0: device.serialNumber }),
          timestamp: device.createdAt,
          markerClass: "bg-cyan-400",
          tags: [
            t('common.technician_8', { var_0: device.technicianId }),
            t('common.type_9', { var_0: itemTypeLabel }),
          ],
        },
      ];

      if (device.status !== "pending" || device.updatedAt) {
        timeline.push({
          id: `rc-status-${device.id}`,
          title: t('common.review_2', { var_0: statusUi.text }),
          description: device.adminNotes || t('common.completed_update_status_device'),
          timestamp: device.updatedAt || device.createdAt,
          markerClass: statusUi.markerClass,
        });
      }

      results.push({
        id: `received-${device.id}`,
        source: "received",
        sourceLabel: t('common.received'),
        title: t('common.receive_1', { var_0: device.terminalId || t('common.device') }),
        operationNumber,
        operationRefs: [device.id],
        serialNumber: device.serialNumber,
        productName: itemTypeLabel,
        statusText: statusUi.text,
        statusClass: statusUi.className,
        createdAt: device.createdAt,
        route: `/received-devices/${device.id}`,
        summary: device.adminNotes || t('common.operation_receive_device'),
        searchable: [
          device.serialNumber,
          device.id,
          operationNumber,
          device.terminalId,
          itemTypeLabel,
          device.adminNotes || "",
          device.technicianId,
        ],
        exactTokens: [device.serialNumber, device.id, operationNumber],
        timeline,
      });
    });

    const processedTransfers = transfers.filter(
      (transfer) => normalizeTransferStatus(transfer.status) !== "pending",
    );
    const groupedTransfers = processedTransfers.reduce<Record<string, { groupId: string; items: WarehouseTransfer[] }>>(
      (acc, transfer) => {
        const groupId = getTransferGroupId(transfer);
        if (!acc[groupId]) {
          acc[groupId] = { groupId, items: [] };
        }
        acc[groupId].items.push(transfer);
        return acc;
      },
      {},
    );

    Object.values(groupedTransfers).forEach((group) => {
      const base = group.items[0];
      const normalizedStatus = normalizeTransferStatus(base?.status);

      if (!base || normalizedStatus === "pending") return;

      const statusUi = transferStatusUi[normalizedStatus === "rejected" ? "rejected" : "accepted"];
      const transferIds = group.items.map((item) => item.id);
      const operationNumber = getReadableOperationNumber("OP", transferIds[0] || group.groupId);
      const itemNames = Array.from(
        new Set(
          group.items.map((item) => {
            const mapped = itemTypeMap.get(item.itemType);
            if (mapped?.nameAr) return mapped.nameAr;
            if (mapped?.nameEn) return mapped.nameEn;
            return item.itemType;
          }),
        ),
      );

      const timeline: TimelineEntry[] = [
        {
          id: `op-create-${group.groupId}`,
          title: t('common.operation_transfer'),
          description: t('common.completed_operation_technician', { var_0: base.warehouseName || t('common.warehouse_1'), var_1: base.technicianName || t('common.item_11173') }),
          timestamp: base.createdAt,
          markerClass: "bg-cyan-400",
          tags: [
            t('common.warehouse_12', { var_0: base.warehouseName || t('common.item_11173') }),
            t('common.technician_8', { var_0: base.technicianName || t('common.item_11173') }),
          ],
        },
      ];

      if (base.respondedAt) {
        timeline.push({
          id: `op-status-${group.groupId}`,
          title: t('common.operation_9', { var_0: statusUi.text }),
          description:
            normalizedStatus === "rejected"
              ? base.rejectionReason || t('common.completed_reject_operation')
              : t('common.completed_operation_successful_1'),
          timestamp: base.respondedAt,
          markerClass: statusUi.markerClass,
        });
      }

      results.push({
        id: `transfer-${group.groupId}`,
        source: "warehouse-transfer",
        sourceLabel: t('common.operation_warehouse'),
        title: t('common.operation_10', { var_0: base.warehouseName || t('common.warehouse_2') }),
        operationNumber,
        operationRefs: [group.groupId, ...transferIds],
        serialNumber: "-",
        productName: itemNames.slice(0, 2).join(" + ") || t('common.items_warehouse'),
        statusText: statusUi.text,
        statusClass: statusUi.className,
        createdAt: base.createdAt,
        route: `/operation-details/${encodeURIComponent(group.groupId)}`,
        summary: base.notes || t('common.items_operation', { var_0: group.items.length }),
        searchable: [
          group.groupId,
          operationNumber,
          ...transferIds,
          base.warehouseName || "",
          base.technicianName || "",
          ...itemNames,
          base.notes || "",
        ],
        exactTokens: [group.groupId, operationNumber, ...transferIds],
        timeline,
      });
    });

    return results.sort(
      (first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
    );
  }, [itemTypeMap, receivedDevices, transfers, withdrawnDevices]);

  // Serialized items (devices/SIMs tracked via scan-in/scan-out custody — the
  // "items" table) are a separate data source from received/withdrawn/transfer
  // records above, and the backend already scopes+filters by the submitted
  // query server-side, so these are mapped directly rather than re-ranked
  // client-side like allResults.
  const serializedItemResults = useMemo<SearchResultItem[]>(() => {
    return serializedItemMatches.map((item) => {
      const itemTypeLabel = item.itemTypeNameAr || item.itemTypeNameEn || t('common.item_11173');
      const shortId = (item.id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
      const operationNumber = `SI-${shortId || "UNKNOWN"}`;

      const timeline: TimelineEntry[] = [
        {
          id: `si-${item.id}`,
          title: itemTypeLabel,
          description: item.ownerName
            ? t('common.technician_8', { var_0: item.ownerName })
            : t('common.item_11173'),
          timestamp: item.createdAt,
          markerClass: "bg-cyan-400",
          tags: [item.status],
        },
      ];

      return {
        id: `serialized-${item.id}`,
        source: "received" as const,
        sourceLabel: itemTypeLabel,
        title: itemTypeLabel,
        operationNumber,
        operationRefs: [item.id],
        serialNumber: item.serialNumber,
        productName: itemTypeLabel,
        statusText: item.status,
        statusClass: "bg-slate-50 border border-slate-200 text-slate-700",
        createdAt: item.createdAt,
        route: item.currentOwnerId && item.itemTypeId
          ? `/technician-details/${encodeURIComponent(item.currentOwnerId)}/item/${encodeURIComponent(item.itemTypeId)}`
          : "/operations-search",
        summary: item.ownerName ? t('common.technician_8', { var_0: item.ownerName }) : "",
        searchable: [item.serialNumber, item.barcode || "", operationNumber, itemTypeLabel, item.ownerName || ""],
        exactTokens: [item.serialNumber, item.barcode || "", operationNumber],
        timeline,
      };
    });
  }, [serializedItemMatches, t]);

  const results = useMemo(() => {
    const ranked = rankSearchResults(allResults, submittedQuery);
    // serializedItemResults are already server-filtered by submittedQuery (the
    // search endpoint only returns matches for the submitted q) — no need to
    // re-run rankSearchResults on them, just merge and keep newest first.
    return [...serializedItemResults, ...ranked].sort(
      (first, second) => new Date(second.createdAt).getTime() - new Date(first.createdAt).getTime(),
    );
  }, [allResults, serializedItemResults, submittedQuery]);

  useEffect(() => {
    if (!results.length) {
      setSelectedResultId(null);
      return;
    }

    const selectedStillExists = selectedResultId && results.some((result) => result.id === selectedResultId);
    if (!selectedStillExists) {
      setSelectedResultId(results[0].id);
    }
  }, [results, selectedResultId]);

  const selectedResult = useMemo(() => {
    if (!results.length) return null;
    if (!selectedResultId) return results[0];
    return results.find((result) => result.id === selectedResultId) || results[0];
  }, [results, selectedResultId]);

  const isLoading = isLoadingReceived || isLoadingWithdrawn || isLoadingTransfers || isLoadingItemTypes;
  const error = receivedError || withdrawnError || transfersError || serializedItemsError;

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    const query = searchInput.trim();
    setSubmittedQuery(query);

    if (!query) {
      setSelectedResultId(null);
      return;
    }

    const ranked = rankSearchResults(allResults, query);

    if (!ranked.length) {
      setSelectedResultId(null);
      return;
    }

    const normalized = normalizeText(query);
    const exactMatches = ranked.filter((result) =>
      result.exactTokens.some((token) => normalizeText(token) === normalized),
    );

    if (exactMatches.length === 1) {
      setLocation(exactMatches[0].route);
      return;
    }

    if (ranked.length === 1) {
      setLocation(ranked[0].route);
      return;
    }

    setSelectedResultId(ranked[0].id);
  };

  const exportToExcel = async () => {
    if (!selectedResult) return;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(t('common.search_5'));
    worksheet.views = [{ rightToLeft: true }];

    worksheet.columns = [
      { header: t('common.item_7966'), key: "field", width: 28 },
      { header: t('common.value'), key: "value", width: 60 },
    ];

    worksheet.addRow({ field: t('common.type_operation'), value: selectedResult.sourceLabel });
    worksheet.addRow({ field: t('common.number_operation'), value: selectedResult.operationNumber });
    worksheet.addRow({ field: t('common.name_6'), value: selectedResult.productName });
    worksheet.addRow({ field: t('common.number_serial_1'), value: selectedResult.serialNumber });
    worksheet.addRow({ field: t('common.status'), value: selectedResult.statusText });
    worksheet.addRow({ field: t('common.date_operation'), value: formatDateTime(selectedResult.createdAt) });
    worksheet.addRow({ field: t('common.item_6380'), value: selectedResult.summary });

    worksheet.addRow({ field: "", value: "" });
    worksheet.addRow({ field: t('common.table'), value: "" });

    selectedResult.timeline.forEach((event, index) => {
      worksheet.addRow({
        field: `${index + 1}. ${event.title}`,
        value: `${formatDateTime(event.timestamp)} | ${event.description}`,
      });
    });

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFDCFDFD" },
      };
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    saveAs(blob, `search-result-${selectedResult.operationNumber}.xlsx`);
  };

  return (
    <div className="space-y-8 text-rassco-text" dir={dir}>
      <section className="rassco-glass p-6">
        <form onSubmit={handleSearchSubmit} className="space-y-4">
          <div className="relative group">
            <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-[#18B2B0] transition-transform group-focus-within:scale-110" />
            </div>

            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              className="h-16 pr-12 pl-36 bg-white border-[rgba(24,178,176,0.15)] focus-visible:ring-[#18B2B0] text-lg text-[#2D3135] placeholder:text-[#6B7280]"
              placeholder={t('common.serial_number_operation_name_1')}
            />

            <div className="absolute inset-y-0 left-2 flex items-center">
              <Button type="submit" className="bg-[#18B2B0] hover:bg-[#149d9b] text-white font-bold px-6">
                {t('common.search_4')}
              </Button>
            </div>
          </div>

          <p className="text-xs text-[#6B7280]">
            {t('dashboard.search_number_number_details')}
          </p>
        </form>
      </section>

      {submittedQuery ? (
        <section className="rassco-glass p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(24,178,176,0.15)] pb-4">
            <div className="flex items-center gap-3">
              <div className="size-11 rounded-xl bg-[rgba(24,178,176,0.08)] border border-[rgba(24,178,176,0.22)] text-[#18B2B0] flex items-center justify-center">
                <Package className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-[#2D3135]">{t('common.results_search_1')}{submittedQuery}</h3>
                <p className="text-xs text-[#6B7280]">{t('common.results')}{results.length}</p>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={exportToExcel}
              disabled={!selectedResult}
              className="border-[rgba(24,178,176,0.22)] bg-white text-[#18B2B0] hover:bg-[rgba(24,178,176,0.05)] hover:text-[#149d9b]"
            >
              <Download className="h-4 w-4 ml-2" />
              {t('dashboard.export_2')}
            </Button>
          </div>

          {isLoading ? (
            <div className="py-10 text-center text-[#6B7280]">{t('common.loading_data_operations')}</div>
          ) : error ? (
            <div className="py-10 text-center text-rose-600">{t('common.error_loading_data_other')}</div>
          ) : !results.length ? (
            <div className="py-10 text-center text-[#6B7280]">
              {t('dashboard.no_results_search_1')}
            </div>
          ) : (
            <>
              {results.length > 1 && (
                <div className="flex flex-wrap gap-2">
                  {results.slice(0, 8).map((result) => (
                    <button
                      key={result.id}
                      type="button"
                      onClick={() => setSelectedResultId(result.id)}
                      className={
                        selectedResult?.id === result.id
                          ? "px-3 py-1.5 rounded-lg border border-[#18B2B0]/40 bg-[#18B2B0]/15 text-[#18B2B0] text-xs font-bold"
                          : "px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-[#2D3135] text-xs hover:border-[#18B2B0]/30"
                      }
                    >
                      {result.operationNumber}
                    </button>
                  ))}
                </div>
              )}

              {selectedResult && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                    <div className="rounded-xl border border-slate-100 bg-[#F8FAFB] p-4">
                      <p className="text-xs text-[#6B7280] mb-1">{t('common.name_6')}</p>
                      <p className="font-bold text-[#2D3135]">{selectedResult.productName || "-"}</p>
                    </div>

                    <div className="rounded-xl border border-slate-100 bg-[#F8FAFB] p-4">
                      <p className="text-xs text-[#6B7280] mb-1">{t('common.number_serial_1')}</p>
                      <p className="font-mono font-bold text-[#18B2B0] tracking-wider">{selectedResult.serialNumber || "-"}</p>
                    </div>

                    <div className="rounded-xl border border-slate-100 bg-[#F8FAFB] p-4">
                      <p className="text-xs text-[#6B7280] mb-1">{t('common.status_2')}</p>
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${selectedResult.statusClass}`}>
                        {selectedResult.statusText}
                      </span>
                    </div>

                    <div className="rounded-xl border border-slate-100 bg-[#F8FAFB] p-4">
                      <p className="text-xs text-[#6B7280] mb-1">{t('common.date_operation')}</p>
                      <p className="font-bold text-[#2D3135]">{formatDate(selectedResult.createdAt)}</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h4 className="text-lg font-bold text-[#2D3135] flex items-center gap-2">
                      <History className="h-5 w-5 text-[#18B2B0]" />
                      {t('common.table_operation')}
                    </h4>

                    <div className="relative pr-6">
                      <div className="absolute top-0 bottom-0 right-1.5 w-px bg-[#18B2B0]/20" />

                      <div className="space-y-6">
                        {selectedResult.timeline.map((event) => (
                          <div key={event.id} className="relative">
                            <div className={`absolute -right-0.5 top-1.5 size-3 rounded-full ${event.markerClass} ring-4 ring-[#18B2B0]/10`} />

                            <div className="mr-5 rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
                              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                                <p className="font-bold text-[#2D3135]">{event.title}</p>
                                <span className="text-xs text-[#6B7280]">{formatDateTime(event.timestamp)}</span>
                              </div>

                              <p className="text-sm text-[#2D3135]">{event.description}</p>

                              {!!event.tags?.length && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {event.tags.map((tag, index) => (
                                    <span
                                      key={`${event.id}-${index}`}
                                      className="px-2 py-1 rounded bg-[#F8FAFB] text-[10px] text-[#6B7280] border border-slate-100"
                                    >
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-100 bg-[#F8FAFB] p-4 shadow-sm flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
                    <div>
                      <p className="text-sm text-[#2D3135] font-semibold">{selectedResult.title}</p>
                      <p className="text-xs text-[#6B7280] mt-1">{selectedResult.summary}</p>
                    </div>

                    <Button
                      type="button"
                      className="bg-[#18B2B0] hover:bg-[#149d9b] text-white font-bold"
                      onClick={() => setLocation(selectedResult.route)}
                    >
                      {t('common.view_details_3')}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      ) : (
        <section className="rassco-glass p-8 text-center text-[#6B7280]">
          <div className="mx-auto w-fit mb-3 rounded-full bg-[#18B2B0]/10 border border-[#18B2B0]/20 p-3">
            <Search className="h-6 w-6 text-[#18B2B0]" />
          </div>
          <h3 className="text-lg font-bold text-[#2D3135] mb-2">{t('common.search_operation')}</h3>
          <p className="text-sm text-[#6B7280]">{t('common.number_serial_number_operation')}</p>
        </section>
      )}

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-1 text-amber-600">
            <TriangleAlert className="h-4 w-4" />
            <span className="text-xs font-bold">{t('common.pending_review')}</span>
          </div>
          <p className="text-sm text-[#2D3135]">{t('common.followup')}</p>
        </div>

        <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-1 text-emerald-600">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-xs font-bold">{t('common.item_9572')}</span>
          </div>
          <p className="text-sm text-[#2D3135]">{t('common.successfully')}</p>
        </div>

        <div className="rounded-xl border border-slate-100 bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-1 text-rose-600">
            <XCircle className="h-4 w-4" />
            <span className="text-xs font-bold">{t('common.item_9566')}</span>
          </div>
          <p className="text-sm text-[#2D3135]">{t('common.review_reason')}</p>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-100 bg-[#F8FAFB] p-4 text-xs text-[#6B7280] flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-[#18B2B0]" />
        {t('dashboard.search_operations_devices_ware')}
      </section>
    </div>
  );
}
