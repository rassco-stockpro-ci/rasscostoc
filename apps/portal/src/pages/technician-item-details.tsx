import { useTranslation, t } from "@/lib/language";
import { useMemo, useState, type MouseEvent } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Plus,
  RefreshCw,
  Router,
  Search,
  Truck,
  Warehouse,
  CheckCircle,
  XCircle,
  Copy,
  Check,
  Smartphone,
  Cable,
  Plug,
  AlertCircle,
  Calendar,
  User,
  MapPin,
  Activity,
  FileText,
  Clock,
  Settings,
  ShieldCheck,
  Navigation,
  Handshake,
  Info,
  Trash2,
  Pencil,
  Loader2,
} from "lucide-react";
import { useActiveItemTypes } from "@/hooks/use-item-types";
import type { TechnicianFixedInventoryEntry, TechnicianMovingInventoryEntry } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ProductTab = "available" | "delivered";

type ReceivedDevice = {
  id: string;
  terminalId: string;
  serialNumber: string;
  itemTypeId: string | null;
  status: "pending" | "approved" | "rejected" | "delivered";
  createdAt: string;
  technicianId: string;
  battery?: boolean;
  chargerCable?: boolean;
  chargerHead?: boolean;
  hasSim?: boolean;
  simCardType?: string | null;
  damagePart?: string | null;
  adminNotes?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  inventoryType?: string;
  regionId?: string | null;
};

type WarehouseTransfer = {
  id: string;
  itemType: string;
  technicianId: string;
  status: string;
  createdAt: string;
};

type ProductOperationRow = {
  id: string;
  productName: string;
  serial: string;
  status: string;
  statusClass: string;
  datetime: string;
  raw?: any;
  type?: "device" | "transfer";
  /** True when row comes from active `items` custody (hard-deletable). */
  isActiveSerialized?: boolean;
};

function createMockOperations(productName: string): ProductOperationRow[] {
  const now = Date.now();
  const inStockClass = "text-orange-400 bg-orange-500/10 border border-orange-500/20";
  const deliveredClass = "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20";

  return [
    {
      id: "mock-1",
      productName,
      serial: "SN-9382-AX11",
      status: t('common.inventory_6'),
      statusClass: inStockClass,
      datetime: formatDateTime(new Date(now - 1000 * 60 * 15).toISOString()),
      type: "device",
      raw: {
        id: "mock-1",
        terminalId: "TID-9382",
        serialNumber: "SN-9382-AX11",
        itemTypeId: null,
        status: "pending",
        createdAt: new Date(now - 1000 * 60 * 15).toISOString(),
        technicianId: "mock-tech",
        battery: true,
        chargerCable: true,
        chargerHead: false,
        hasSim: true,
        simCardType: "Zain",
        damagePart: t('common.item_27116'),
        adminNotes: null,
        approvedBy: null,
        approvedAt: null,
        inventoryType: "moving",
      }
    },
    {
      id: "mock-2",
      productName,
      serial: "SN-9382-AX12",
      status: t('common.inventory_6'),
      statusClass: inStockClass,
      datetime: formatDateTime(new Date(now - 1000 * 60 * 40).toISOString()),
      type: "device",
      raw: {
        id: "mock-2",
        terminalId: "TID-9383",
        serialNumber: "SN-9382-AX12",
        itemTypeId: null,
        status: "approved",
        createdAt: new Date(now - 1000 * 60 * 40).toISOString(),
        technicianId: "mock-tech",
        battery: true,
        chargerCable: true,
        chargerHead: true,
        hasSim: false,
        simCardType: null,
        damagePart: null,
        adminNotes: t('common.completed_device'),
        approvedBy: t('common.supervisor_1'),
        approvedAt: new Date(now - 1000 * 60 * 30).toISOString(),
        inventoryType: "fixed",
      }
    },
    {
      id: "mock-3",
      productName,
      serial: "SN-9382-AX13",
      status: t('common.completed_3'),
      statusClass: deliveredClass,
      datetime: formatDateTime(new Date(now - 1000 * 60 * 90).toISOString()),
      type: "device",
      raw: {
        id: "mock-3",
        terminalId: "TID-9384",
        serialNumber: "SN-9382-AX13",
        itemTypeId: null,
        status: "delivered",
        createdAt: new Date(now - 1000 * 60 * 90).toISOString(),
        technicianId: "mock-tech",
        battery: true,
        chargerCable: true,
        chargerHead: true,
        hasSim: true,
        simCardType: "STC",
        damagePart: null,
        adminNotes: t('common.completed_successfully_2'),
        approvedBy: t('common.supervisor_1'),
        approvedAt: new Date(now - 1000 * 60 * 80).toISOString(),
        inventoryType: "moving",
      }
    },
    {
      id: "mock-4",
      productName,
      serial: "SN-9382-AX14",
      status: t('common.completed_3'),
      statusClass: deliveredClass,
      datetime: formatDateTime(new Date(now - 1000 * 60 * 180).toISOString()),
      type: "device",
      raw: {
        id: "mock-4",
        terminalId: "TID-9385",
        serialNumber: "SN-9382-AX14",
        itemTypeId: null,
        status: "delivered",
        createdAt: new Date(now - 1000 * 60 * 180).toISOString(),
        technicianId: "mock-tech",
        battery: false,
        chargerCable: false,
        chargerHead: false,
        hasSim: false,
        simCardType: null,
        damagePart: t('common.dashboard'),
        adminNotes: t('common.completed_receive_report_damag'),
        approvedBy: t('common.supervisor_1'),
        approvedAt: new Date(now - 1000 * 60 * 170).toISOString(),
        inventoryType: "fixed",
      }
    },
  ];
}

function arNumber(value: number): string {
  return new Intl.NumberFormat("ar-SA").format(value);
}

function formatDateTime(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleString("ar-SA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalize(value?: string | null): string {
  return (value || "").trim().toLowerCase();
}

function statusUi(status: string): { text: string; className: string; delivered: boolean } {
  const normalized = normalize(status);

  if (normalized === "delivered" || normalized === "installed") {
    return {
      text: t('common.completed_3'),
      className: "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20",
      delivered: true,
    };
  }

  if (normalized === "rejected") {
    return {
      text: t('common.rejected'),
      className: "text-rose-400 bg-rose-500/10 border border-rose-500/20",
      delivered: false,
    };
  }

  if (normalized === "approved" || normalized === "accepted" || normalized === "received_by_technician" || normalized === "in_transit_custody") {
    return {
      text: t('common.inventory_6'),
      className: "text-orange-400 bg-orange-500/10 border border-orange-500/20",
      delivered: false,
    };
  }

  if (normalized === "in-stock" || normalized === "available" || normalized === "pending") {
    return {
      text: t('common.inventory_6'),
      className: "text-orange-400 bg-orange-500/10 border border-orange-500/20",
      delivered: false,
    };
  }

  return {
    text: t('common.inventory_6'),
    className: "text-orange-400 bg-orange-500/10 border border-orange-500/20",
    delivered: false,
  };
}

export default function TechnicianItemDetailsPage() {
  const { t, dir } = useTranslation();
  const [, params] = useRoute("/technician-details/:technicianId/item/:itemTypeId");
  const technicianId = params?.technicianId;
  const itemTypeId = params?.itemTypeId;

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const canHardDeleteSerialized = user?.role === "admin";
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<ProductTab>("available");

  // Detailed Modal states
  const [selectedRow, setSelectedRow] = useState<ProductOperationRow | null>(null);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [adminNotesText, setAdminNotesText] = useState<string>("");
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [rowPendingDelete, setRowPendingDelete] = useState<ProductOperationRow | null>(null);

  // Edit Device Modal States
  const [editingRow, setEditingRow] = useState<ProductOperationRow | null>(null);
  const [editSerialNumber, setEditSerialNumber] = useState("");
  const [editTerminalId, setEditTerminalId] = useState("");
  const [editSimCardType, setEditSimCardType] = useState("");
  const [editAdminNotes, setEditAdminNotes] = useState("");
  const [editStatus, setEditStatus] = useState("");

  const deleteLabelForCategory = (category?: string | null) =>
    category === "sim" ? "الشريحة" : "الجهاز";

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const { data: technician } = useQuery<{ id: string; fullName: string; city?: string }>({
    queryKey: [`/api/technicians/${technicianId}`],
    enabled: !!technicianId,
  });

  const { data: itemTypes = [], isLoading: isLoadingItemTypes } = useActiveItemTypes();

  const { data: fixedEntries = [], isLoading: isLoadingFixed } = useQuery<TechnicianFixedInventoryEntry[]>({
    queryKey: [`/api/technicians/${technicianId}/fixed-inventory-entries`],
    enabled: !!technicianId,
  });

  const { data: movingEntries = [], isLoading: isLoadingMoving } = useQuery<TechnicianMovingInventoryEntry[]>({
    queryKey: [`/api/technicians/${technicianId}/moving-inventory-entries`],
    enabled: !!technicianId,
  });

  const { data: receivedDevices = [], isLoading: isLoadingReceived } = useQuery<ReceivedDevice[]>({
    queryKey: ["/api/received-devices"],
    enabled: !!technicianId,
  });

  const { data: warehouseTransfers = [] } = useQuery<WarehouseTransfer[]>({
    queryKey: ["/api/warehouse-transfers"],
    enabled: !!technicianId,
  });

  const { data: serializedItems = [], isLoading: isLoadingSerialized } = useQuery<any[]>({
    queryKey: [`/api/technicians/${technicianId}/serialized-items`],
    enabled: !!technicianId,
  });

  const { data: deliveredSerializedItems = [], isLoading: isLoadingDeliveredSerialized } = useQuery<any[]>({
    queryKey: [`/api/technicians/${technicianId}/delivered-items?itemTypeId=${itemTypeId}`],
    enabled: !!technicianId && !!itemTypeId,
  });

  const isLoading = isLoadingItemTypes || isLoadingFixed || isLoadingMoving || isLoadingReceived || isLoadingSerialized || isLoadingDeliveredSerialized;

  const itemType = useMemo(() => {
    return itemTypes.find((item) => item.id === itemTypeId);
  }, [itemTypeId, itemTypes]);

  const fixedEntry = fixedEntries.find((entry) => entry.itemTypeId === itemTypeId);
  const movingEntry = movingEntries.find((entry) => entry.itemTypeId === itemTypeId);

  const fixedTotal = Number(fixedEntry?.boxes || 0) + Number(fixedEntry?.units || 0);
  const isSerialized = itemType?.requiresSerial || itemType?.category === 'sim' || itemType?.category === 'devices';
  const movingTotal = isSerialized
    ? (serializedItems || []).filter((item: any) => item.itemTypeId === itemTypeId).length
    : Number(movingEntry?.boxes || 0) + Number(movingEntry?.units || 0);
  const totalStock = fixedTotal + movingTotal;

  const formatSerialWithPrefix = (serialRaw?: string | null, type?: any) => {
    if (!serialRaw || serialRaw === "-") return "-";
    const s = String(serialRaw).trim();
    if (/[\s\u0600-\u06FF]/.test(s)) return "-";
    if (!type?.serialPrefix) return s;
    const prefixes = String(type.serialPrefix).split(",").map((p) => p.trim().toUpperCase());
    const alphabeticPrefix = prefixes.find((p) => /^[A-Z]+$/.test(p));
    if (alphabeticPrefix && !s.toUpperCase().startsWith(alphabeticPrefix)) {
      return `${alphabeticPrefix}${s}`;
    }
    return s;
  };

  const liveOperations = useMemo(() => {
    const productNameAr = itemType?.nameAr || t('common.item_6369');
    const productNameEn = itemType?.nameEn || "";
    const deliveredClass = "text-emerald-400 bg-emerald-500/10 border border-emerald-500/20";
    const inStockClass = "text-orange-400 bg-orange-500/10 border border-orange-500/20";

    const activeSerializedRows: ProductOperationRow[] = (serializedItems || [])
      .filter((item) => item.itemTypeId === itemTypeId)
      .map((item) => {
        const serialFormatted = formatSerialWithPrefix(item.serialNumber, itemType);
        return {
          id: `active-${item.id}`,
          productName: item.itemTypeName || productNameAr,
          serial: serialFormatted,
          status: t('common.inventory_6'),
          statusClass: inStockClass,
          datetime: formatDateTime(item.createdAt),
          raw: {
            id: item.id,
            serialNumber: serialFormatted !== "-" ? serialFormatted : item.serialNumber,
            itemTypeId: item.itemTypeId,
            status: item.status || "RECEIVED_BY_TECHNICIAN",
            createdAt: item.createdAt,
            technicianId,
            inventoryType: "moving",
            simCardType: item.carrierName,
            hasSim: !!item.carrierName,
          },
          type: "device" as const,
          isActiveSerialized: true,
        };
      });

    const deliveredV3Rows: ProductOperationRow[] = (deliveredSerializedItems || [])
      .filter((item) => item.itemTypeId === itemTypeId)
      .map((item) => {
        const serialFormatted = formatSerialWithPrefix(item.serialNumber, itemType);
        return {
          id: `delivered-${item.movementId || item.id}`,
          productName: item.itemTypeName || productNameAr,
          serial: serialFormatted,
          status: t('common.completed_3'),
          statusClass: deliveredClass,
          datetime: formatDateTime(item.deliveredAt || item.createdAt),
          raw: {
            id: item.id,
            serialNumber: serialFormatted !== "-" ? serialFormatted : item.serialNumber,
            itemTypeId: item.itemTypeId,
            status: "delivered",
            createdAt: item.deliveredAt || item.createdAt,
            technicianId,
            inventoryType: "moving",
            simCardType: item.carrierName,
            hasSim: !!item.carrierName,
            adminNotes: item.notes || (item.referenceId ? t('common.request_1', { var_0: item.referenceId }) : null),
          },
          type: "device" as const,
        };
      });

    const receivedRows: ProductOperationRow[] = receivedDevices
      .filter((device) => device.technicianId === technicianId)
      .filter((device) => {
        if (device.itemTypeId === itemTypeId) return true;
        if (!device.itemTypeId) {
          const source = normalize(device.terminalId);
          return source.includes(normalize(productNameAr)) || source.includes(normalize(productNameEn));
        }
        return false;
      })
      .map((device) => {
        const ui = statusUi(device.status);
        const serialFormatted = formatSerialWithPrefix(device.serialNumber || device.terminalId, itemType);
        return {
          id: `rc-${device.id}`,
          productName: productNameAr,
          serial: serialFormatted,
          status: ui.text,
          statusClass: ui.className,
          datetime: formatDateTime(device.createdAt),
          raw: {
            ...device,
            serialNumber: serialFormatted !== "-" ? serialFormatted : device.serialNumber,
          },
          type: "device" as const,
        };
      });

    const transferRows: ProductOperationRow[] = warehouseTransfers
      .filter((transfer) => transfer.technicianId === technicianId)
      .filter((transfer) => {
        const transferType = normalize(transfer.itemType);
        return transferType === normalize(itemTypeId) || transferType === normalize(productNameEn);
      })
      .map((transfer) => {
        const ui = statusUi(transfer.status);
        const rawSerial = (transfer as any).serialNumber || (transfer as any).serial;
        const serialFormatted = rawSerial ? formatSerialWithPrefix(rawSerial, itemType) : "-";
        return {
          id: `tr-${transfer.id}`,
          productName: productNameAr,
          serial: serialFormatted,
          status: ui.text,
          statusClass: ui.className,
          datetime: formatDateTime(transfer.createdAt),
          raw: transfer,
          type: "device" as const,
        };
      });

    // Prefer active serialized (hard-deletable) over delivered/legacy for same serial
    const rows = [...activeSerializedRows, ...deliveredV3Rows, ...receivedRows, ...transferRows];
    const seenSerials = new Set<string>();
    const uniqueRows: ProductOperationRow[] = [];

    for (const row of rows) {
      if (row.serial && row.serial !== "-") {
        if (seenSerials.has(row.serial)) continue;
        seenSerials.add(row.serial);
      }
      uniqueRows.push(row);
    }

    return uniqueRows;
  }, [itemType, itemTypeId, receivedDevices, technicianId, warehouseTransfers, serializedItems, deliveredSerializedItems]);

  const hasLiveData = true; // never fall back to mock inventory for a real technician item page
  const productOperations = liveOperations;

  const deliveredRows = productOperations.filter((row) => row.status === t('common.completed_3'));
  const availableRows = productOperations.filter((row) => row.status !== t('common.completed_3'));

  const shownRows = (tab === "available" ? availableRows : deliveredRows).filter((row) => {
    const term = normalize(search);
    if (!term) return true;

    return (
      normalize(row.productName).includes(term) ||
      normalize(row.serial).includes(term) ||
      normalize(row.status).includes(term)
    );
  });

  const deliveredCount = Math.max(deliveredRows.length, deliveredSerializedItems.length);
  const remainingStock = movingTotal + fixedTotal;
  const scannedTotal = remainingStock + deliveredCount;
  const effectiveTotalStock = scannedTotal;
  const remainingDisplay = remainingStock;
  const urgentCount = remainingStock > 0 && remainingStock < 20 ? remainingStock : 0;
  const estimatedValue = remainingStock * 35;

  const displayTechnicianName = technician?.fullName || "-";
  const displayItemName = itemType?.nameAr || t('common.item_12813');

  const refreshData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [`/api/technicians/${technicianId}/fixed-inventory-entries`] }),
      queryClient.invalidateQueries({ queryKey: [`/api/technicians/${technicianId}/moving-inventory-entries`] }),
      queryClient.invalidateQueries({ queryKey: [`/api/technicians/${technicianId}/serialized-items`] }),
      queryClient.invalidateQueries({ queryKey: [`/api/technicians/${technicianId}/delivered-items?itemTypeId=${itemTypeId}`] }),
      queryClient.invalidateQueries({ queryKey: ["/api/received-devices"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse-transfers"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/item-types/active"] }),
    ]);
  };

  const updateStatusMutation = useMutation({
    mutationFn: async ({ status, adminNotes }: { status: "approved" | "rejected"; adminNotes: string }) => {
      if (!selectedRow?.raw?.id) return;
      const deviceId = selectedRow.raw.id;
      const res = await apiRequest("PATCH", `/api/received-devices/${deviceId}/status`, {
        status,
        adminNotes,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: t('common.completed_update_status_device_1'),
        description: t('common.completed_successfully_logs'),
      });
      refreshData();
      setSelectedRow(null);
    },
    onError: (err: any) => {
      toast({
        title: t('common.fail_update_status'),
        description: err.message || t('common.error_2'),
        variant: "destructive",
      });
    },
  });

  const openEditModal = (row: ProductOperationRow, event?: MouseEvent) => {
    event?.stopPropagation();
    event?.preventDefault();
    setEditingRow(row);
    setEditSerialNumber(row.serial && row.serial !== "-" ? row.serial : row.raw?.serialNumber || "");
    setEditTerminalId(row.raw?.terminalId || "");
    setEditSimCardType(row.raw?.simCardType || row.raw?.carrierName || "");
    setEditAdminNotes(row.raw?.adminNotes || row.raw?.notes || "");
    setEditStatus(
      row.raw?.status || (row.status === t('common.completed_3') ? "delivered" : "approved")
    );
  };

  const updateDeviceMutation = useMutation({
    mutationFn: async ({
      row,
      serialNumber,
      terminalId,
      simCardType,
      adminNotes,
      status,
    }: {
      row: ProductOperationRow;
      serialNumber: string;
      terminalId: string;
      simCardType: string;
      adminNotes: string;
      status: string;
    }) => {
      const rawId = row.raw?.id || row.id.replace(/^(active-|delivered-|rc-|tr-)/, "");
      if (!rawId) throw new Error("معرّف المادة غير موجود");

      const isSerializedItem =
        row.isActiveSerialized ||
        row.id.startsWith("active-") ||
        row.id.startsWith("delivered-");

      if (isSerializedItem) {
        const res = await apiRequest("PATCH", `/api/serialized-items/${rawId}`, {
          serialNumber,
          simCardType,
          carrierName: simCardType,
          status,
        });
        return res.json();
      } else if (row.id.startsWith("tr-")) {
        // Note: PATCH /api/warehouse-transfers/:id/status only accepts
        // approved|accepted|rejected — it does not support arbitrary status values.
        const res = await apiRequest("PATCH", `/api/warehouse-transfers/${rawId}/status`, {
          status,
          reason: adminNotes,
        });
        return res.json();
      } else {
        const res = await apiRequest("PATCH", `/api/received-devices/${rawId}`, {
          serialNumber,
          terminalId,
          simCardType,
          adminNotes,
          status,
        });
        return res.json();
      }
    },
    onSuccess: () => {
      toast({
        title: "تم تحديث البيانات",
        description: "تم حفظ التعديلات على الجهاز بنجاح",
      });
      setEditingRow(null);
      setSelectedRow(null);
      refreshData();
    },
    onError: (err: any) => {
      toast({
        title: "فشل التحديث",
        description: err?.message || "حدث خطأ أثناء تعديل البيانات",
        variant: "destructive",
      });
    },
  });

  const hardDeleteSerializedMutation = useMutation({
    mutationFn: async (row: ProductOperationRow) => {
      const rawId = row.raw?.id || row.id.replace(/^(active-|delivered-|rc-|tr-)/, "");
      if (!rawId) throw new Error("معرّف المادة غير موجود");

      const isSerializedItem =
        row.isActiveSerialized ||
        row.id.startsWith("active-") ||
        row.id.startsWith("delivered-");

      if (isSerializedItem) {
        const res = await apiRequest("DELETE", `/api/serialized-items/${rawId}`);
        const data = await res.json().catch(() => ({}));
        return { ...data, deletedId: rawId };
      } else if (row.id.startsWith("tr-")) {
        const res = await apiRequest("DELETE", `/api/warehouse-transfers/${rawId}`);
        const data = await res.json().catch(() => ({}));
        return { ...data, deletedId: rawId };
      } else {
        const res = await apiRequest("DELETE", `/api/received-devices/${rawId}`);
        const data = await res.json().catch(() => ({}));
        return { ...data, deletedId: rawId };
      }
    },
    onSuccess: (data: any) => {
      const label = deleteLabelForCategory(itemType?.category);
      const deletedId = data?.deletedId || rowPendingDelete?.raw?.id;

      // Optimistic: drop from serialized custody cache immediately
      if (deletedId && technicianId) {
        queryClient.setQueryData(
          [`/api/technicians/${technicianId}/serialized-items`],
          (prev: any) => (Array.isArray(prev) ? prev.filter((x: any) => x?.id !== deletedId) : prev)
        );
      }

      toast({
        title: "تم الحذف",
        description: `تم حذف ${label} نهائياً من قاعدة البيانات`,
      });
      if (selectedRow?.raw?.id && deletedId && selectedRow.raw.id === deletedId) {
        setSelectedRow(null);
      }
      setRowPendingDelete(null);
      refreshData();
    },
    onError: (err: any) => {
      const label = deleteLabelForCategory(itemType?.category);
      const status = err?.status;
      const description =
        status === 429
          ? "تم تجاوز حد الطلبات. انتظر لحظات ثم أعد المحاولة."
          : err?.message || `تعذر حذف ${label} من قاعدة البيانات`;
      toast({
        title: `فشل حذف ${label}`,
        description,
        variant: "destructive",
      });
    },
  });

  const requestHardDelete = (row: ProductOperationRow, event?: MouseEvent) => {
    event?.stopPropagation();
    event?.preventDefault();
    if (!row.raw?.id) return;
    setRowPendingDelete(row);
  };

  const isStepCompleted = (stepIndex: number, device: ReceivedDevice) => {
    const status = (device.status || "").toLowerCase();
    switch (stepIndex) {
      case 0:
        return true; // scanned in is always complete
      case 1:
        return status === "approved" || status === "rejected" || status === "delivered";
      case 2:
        return status === "approved" || status === "delivered";
      case 3:
        return status === "delivered";
      default:
        return false;
    }
  };

  const renderDetailItem = (label: string, value: string, copyable = false) => (
    <div className="flex justify-between items-center py-3 border-b border-[#E2E8F0]/60 last:border-0 text-sm">
      <span className="text-[#6B7280] font-medium">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="font-bold text-[#2D3135]">{value || "-"}</span>
        {copyable && value && value !== "-" && (
          <button
            onClick={() => copyToClipboard(value)}
            className="text-[#18B2B0] hover:text-[#149D9B] p-1 hover:bg-[#18B2B0]/10 rounded transition-all"
          >
            {copiedText === value ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  );

  const renderAccessoryChip = (label: string, isPresent: boolean, Icon: any) => {
    const colorClass = isPresent 
      ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-400" 
      : "border-[#E2E8F0] bg-[#F8FAFC] text-[#6B7280]";
    return (
      <div className={`flex items-center justify-between p-3.5 rounded-xl border ${colorClass} transition-all`}>
        <div className="flex items-center gap-2.5">
          <Icon className="w-4 h-4 shrink-0" />
          <span className="text-xs font-bold">{label}</span>
        </div>
        {isPresent ? <CheckCircle className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
      </div>
    );
  };

  const renderProductImage = (row: ProductOperationRow) => {
    const category = itemType?.category || "other";
    const nameAr = itemType?.nameAr || row.productName || "";
    const nameEn = itemType?.nameEn || "";
    const name = (nameAr + " " + nameEn + " " + (row.raw?.simCardType || "")).toLowerCase();

    let gradient = "from-[#E8F7F7] to-[#F0F4F8] border-[#18B2B0]/35";
    let Icon = Smartphone;
    let brandText = "";
    let brandTextColor = "text-[#18B2B0]";
    let imageSrc = "";

    if (category === "sim") {
      Icon = Handshake; // or CreditCard
      if (name.includes("stc") || name.includes(t('common.item_9611'))) {
        gradient = "from-purple-50 to-indigo-50 border-purple-200";
        brandText = "stc";
        brandTextColor = "text-purple-700";
        imageSrc = "/assets/stc.jpg";
      } else if (name.includes("zain") || name.includes(t('common.zain'))) {
        gradient = "from-lime-50 to-neutral-50 border-lime-300";
        brandText = "Zain";
        brandTextColor = "text-lime-700";
        imageSrc = "/assets/zein.png";
      } else if (name.includes("mobily") || name.includes(t('common.mobily'))) {
        gradient = "from-cyan-50 to-blue-50 border-cyan-200";
        brandText = "Mobily";
        brandTextColor = "text-cyan-700";
        imageSrc = "/assets/mobile.png";
      } else if (name.includes("lebara") || name.includes(t('common.lebara'))) {
        gradient = "from-red-50 to-rose-50 border-red-200";
        brandText = "Lebara";
        brandTextColor = "text-red-700";
        imageSrc = "/assets/libar.png";
      } else {
        gradient = "from-teal-50 to-[#F0F9F9] border-teal-200";
        brandText = "SIM";
        brandTextColor = "text-teal-700";
      }
    } else if (category === "devices") {
      Icon = Smartphone;
      imageSrc = "/assets/1.png";
      if (name.includes("950")) {
        gradient = "from-blue-50 to-[#E8F7F7] border-[#18B2B0]/40";
        brandText = "N950";
      } else if (name.includes("9100")) {
        gradient = "from-indigo-50 to-blue-50 border-indigo-200";
        brandText = "I9100";
      } else if (name.includes("9000")) {
        gradient = "from-slate-50 to-gray-50 border-slate-200";
        brandText = "I9000";
      } else {
        gradient = "from-[#F8FAFB] to-[#EEF2F6] border-[#E2E8F0]";
        brandText = "POS";
      }
    } else if (category === "accessories") {
      gradient = "from-purple-50 to-fuchsia-50 border-purple-200";
      Icon = Cable;
      if (name.includes("battery") || name.includes(t('common.battery'))) {
        Icon = Plug;
        brandText = t('common.battery');
      } else {
        brandText = t('common.item_6392');
      }
    } else if (category === "stickers" || name.includes(t('common.sticker')) || name.includes("sticker") || name.includes("mol") || name.includes("label") || name.includes(t('common.stickers_1')) || name.includes("stickers")) {
      gradient = "from-emerald-50 to-teal-50 border-emerald-200";
      Icon = FileText;
      brandText = t('common.sticker');
      imageSrc = "/assets/mol.png";
    } else if (category === "papers") {
      gradient = "from-amber-50 to-orange-50 border-amber-200";
      Icon = FileText;
      brandText = t('common.paper');
    } else if (
      name.includes("950") ||
      name.includes("9100") ||
      name.includes("9000") ||
      name.includes("pos") ||
      (itemTypeId || "").toLowerCase().includes("n950") ||
      (itemTypeId || "").toLowerCase().includes("i9000") ||
      (itemTypeId || "").toLowerCase().includes("i9100")
    ) {
      // Fallback when category is missing/other but product is clearly a POS device
      Icon = Smartphone;
      imageSrc = "/assets/1.png";
      if (name.includes("950") || (itemTypeId || "").toLowerCase().includes("n950")) {
        gradient = "from-blue-50 to-[#E8F7F7] border-[#18B2B0]/40";
        brandText = "N950";
      } else if (name.includes("9100") || (itemTypeId || "").toLowerCase().includes("i9100")) {
        gradient = "from-indigo-50 to-blue-50 border-indigo-200";
        brandText = "I9100";
      } else if (name.includes("9000") || (itemTypeId || "").toLowerCase().includes("i9000")) {
        gradient = "from-slate-50 to-gray-50 border-slate-200";
        brandText = "I9000";
      } else {
        gradient = "from-[#F8FAFB] to-[#EEF2F6] border-[#E2E8F0]";
        brandText = "POS";
      }
    }

    return (
      <div className={`relative w-14 h-14 rounded-xl border bg-gradient-to-tr ${gradient} flex flex-col items-center justify-center shadow-sm overflow-hidden shrink-0 group-hover:scale-105 transition-transform duration-200`}>
        <div className="absolute inset-0 bg-white/40 opacity-0 group-hover:opacity-100 transition-opacity" />
        
        {imageSrc ? (
          <img src={imageSrc} alt={brandText || category} className="w-11 h-11 object-contain" />
        ) : (
          <Icon className="w-5 h-5 text-[#18B2B0] mt-0.5" />
        )}
        
        {brandText && (
          <span className={`absolute bottom-0.5 text-[8px] font-black tracking-tighter ${brandTextColor} bg-white/90 px-1 rounded-sm uppercase scale-90 border border-[#E6E8EC]`}>
            {brandText}
          </span>
        )}

        {category === "sim" && (
          <div className="absolute top-1 right-1 w-2 h-2 border border-white/20 rounded-sm bg-amber-400/25" />
        )}
      </div>
    );
  };

  const steps = [
    { title: t('common.item_11143'), desc: t('common.scan_device'), icon: Activity },
    { title: t('common.item_12688'), desc: t('common.supervisor'), icon: ShieldCheck },
    { title: t('common.item_9539'), desc: t('common.add_6'), icon: Boxes },
    { title: t('common.item_11163_1'), desc: t('common.customer'), icon: Truck },
  ];

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16 rounded-xl" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <Skeleton className="h-[420px] rounded-xl" />
      </div>
    );
  }

  return (
    <div className="rassco-page rassco-light-surface space-y-8" dir={dir}>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h2 className="text-3xl font-black text-[#2D3135] tracking-tight">{t('common.item_19145')}</h2>
          <p className="text-[#6B7280] mt-1">{t('common.view_details_4')}{displayItemName}</p>
          <p className="text-xs text-[#18B2B0] mt-1">{t('common.technician_1')}{displayTechnicianName}</p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <Button
            onClick={refreshData}
            variant="outline"
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#18B2B0]/10 text-[#18B2B0] border-[#18B2B0]/30 font-bold text-sm hover:bg-[#18B2B0]/15"
          >
            <RefreshCw className="h-4 w-4" />
            {t('common.update_data')}
          </Button>
          <Button className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#18B2B0] text-white font-bold text-sm hover:opacity-90 transition-all shadow-lg shadow-[#18B2B0]/20">
            <Plus className="h-4 w-4" />
            {t('common.add')}
          </Button>
          <Link href={`/technician-details/${technicianId}`}>
            <Button variant="outline" className="inline-flex items-center gap-2 border-[#E2E8F0] text-[#4B5563] hover:bg-[rgba(24,178,176,0.06)]">
              <ArrowLeft className="h-4 w-4 shrink-0" />
              {t('common.item_6366')}
            </Button>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="bg-white border-[rgba(24,178,176,0.18)]">
          <CardContent className="p-6">
            <p className="text-[#6B7280] text-sm font-medium mb-2">{t('common.total_scan_active')}</p>
            <div className="flex items-end gap-3">
              <h3 className="text-3xl font-black text-[#2D3135]">{arNumber(effectiveTotalStock)}</h3>
              <span className="text-emerald-400 text-sm font-bold flex items-center gap-1 mb-1">+5%</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white border-[rgba(24,178,176,0.18)]">
          <CardContent className="p-6">
            <p className="text-[#6B7280] text-sm font-medium mb-2">{t('common.inventory_5')}</p>
            <div className="flex items-end gap-3">
              <h3 className="text-3xl font-black text-[#2D3135]">{arNumber(deliveredCount)}</h3>
              <span className="text-emerald-400 text-sm font-bold flex items-center gap-1 mb-1">+12%</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white border-orange-500/20">
          <CardContent className="p-6">
            <p className="text-[#6B7280] text-sm font-medium mb-2">{t('common.total_inventory_1')}</p>
            <div className="flex items-end gap-3">
              <h3 className="text-3xl font-black text-[#2D3135]">{arNumber(remainingDisplay)}</h3>
              <span className="text-orange-400 text-sm font-bold flex items-center gap-1 mb-1">
                <AlertTriangle className="h-3 w-3" />
                {urgentCount > 0 ? t('common.item_6352') : t('common.item_7957')}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-white border-[rgba(24,178,176,0.18)]">
          <CardContent className="p-6">
            <p className="text-[#6B7280] text-sm font-medium mb-2">{t('common.total_value')}</p>
            <div className="flex items-end gap-3">
              <h3 className="text-3xl font-black text-[#2D3135]">{arNumber(estimatedValue)}</h3>
              <span className="text-[#18B2B0] text-xs font-bold mb-1">SAR</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mb-6">
        <div className="relative group">
          <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none">
            <Search className="h-4 w-4 text-[#18B2B0]/60" />
          </div>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full md:w-96 py-3 pr-11 pl-4 rounded-xl text-sm text-[#2D3135] bg-white border-[#18B2B0]/30"
            placeholder={t('common.serial_3')}
          />
          <div className="absolute inset-y-0 left-0 flex items-center pl-3">
            <span className="text-[10px] text-[#6B7280] bg-[#F3F4F6] px-2 py-1 rounded border border-[#E2E8F0]">Ctrl + K</span>
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ProductTab)} className="w-full">
        <TabsList className="bg-transparent border-b border-[rgba(24,178,176,0.18)] mb-6 rounded-none p-0 h-auto gap-8">
          <TabsTrigger
            value="available"
            className="inline-flex items-center justify-center gap-2 pb-4 px-2 border-b-2 border-transparent data-[state=active]:border-cyan-400 data-[state=active]:text-[#18B2B0] text-[#6B7280] rounded-none leading-none"
          >
            <Warehouse className="h-4 w-4 shrink-0" />
            {t('inventory.inventory_present_count', { count: availableRows.length })}
          </TabsTrigger>
          <TabsTrigger
            value="delivered"
            className="inline-flex items-center justify-center gap-2 pb-4 px-2 border-b-2 border-transparent data-[state=active]:border-cyan-400 data-[state=active]:text-[#18B2B0] text-[#6B7280] rounded-none leading-none"
          >
            <Truck className="h-4 w-4 shrink-0" />
            {t('inventory.inventory_count', { count: deliveredCount })}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="rounded-xl overflow-hidden border border-[rgba(24,178,176,0.18)] shadow-2xl shadow-black/20 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="bg-cyan-400/5 border-b border-[rgba(24,178,176,0.18)]">
                <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider">{t('common.name_6')}</th>
                <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t('common.number_serial_1')}</th>
                <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t('common.status_4')}</th>
                <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t('common.date')}</th>
                <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-left">{t('common.item_11035')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cyan-400/5">
              {shownRows.length === 0 ? (
                <tr>
                  <td className="px-6 py-8 text-center text-[#6B7280]" colSpan={5}>
                    {t('inventory.no_data_no_active')}
                  </td>
                </tr>
              ) : (
                shownRows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => {
                      if (row.type === "device") {
                        setSelectedRow(row);
                        setActiveStepIndex(
                          row.raw?.status === "delivered" 
                            ? 3 
                            : row.raw?.status === "approved" 
                            ? 2 
                            : row.raw?.status === "rejected"
                            ? 1
                            : 0
                        );
                        setAdminNotesText("");
                      } else {
                        setSelectedRow(row);
                        setActiveStepIndex(0);
                      }
                    }}
                    className="hover:bg-cyan-400/5 transition-colors group cursor-pointer"
                  >
                    <td className="px-6 py-5">
                      <div className="flex items-center gap-3">
                        {renderProductImage(row)}
                        <div>
                          <p className="text-sm font-bold text-[#2D3135] group-hover:text-[#18B2B0] transition-colors">{row.productName}</p>
                          <p className="text-[10px] text-[#6B7280]">{itemType?.nameEn || "Product"}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-5 text-center">
                      <div className="inline-flex items-center justify-center gap-1.5">
                        <span className="font-mono text-xs text-[#18B2B0] bg-cyan-400/5 px-2.5 py-1 rounded-md font-bold">{row.serial}</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-[#18B2B0] hover:bg-[#18B2B0]/10 hover:text-[#149D9B] rounded-lg transition-colors"
                          title="تعديل الرقم التسلسلي"
                          data-testid={`button-edit-serial-${row.id}`}
                          onClick={(event) => openEditModal(row, event)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                    <td className="px-6 py-5 text-center">
                      <span className="text-sm font-bold text-[#2D3135]">{row.status}</span>
                    </td>
                    <td className="px-6 py-5 text-center">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold ${row.statusClass}`}>
                        {row.datetime}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-left">
                      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-[#18B2B0] hover:bg-[#18B2B0]/10 hover:text-[#149D9B] rounded-lg transition-colors"
                          title="تعديل بيانات الجهاز"
                          data-testid={`button-edit-device-${row.id}`}
                          onClick={(event) => openEditModal(row, event)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-rose-500 hover:bg-rose-50 hover:text-rose-700 rounded-lg transition-colors"
                          title={`حذف ${deleteLabelForCategory(itemType?.category)} نهائياً`}
                          data-testid={`button-hard-delete-serialized-${row.id}`}
                          onClick={(event) => requestHardDelete(row, event)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-[#6B7280] hover:text-[#18B2B0] rounded-lg"
                          title="عرض التفاصيل"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="bg-cyan-400/5 px-6 py-4 border-t border-[rgba(24,178,176,0.18)] flex items-center justify-between">
          <p className="text-xs text-[#6B7280]">{t('common.view')}{shownRows.length}{t('common.item_8007')}{productOperations.length}{t('common.item_1')}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="icon" className="w-8 h-8 border-[#18B2B0]/30 text-[#6B7280]" disabled>
              <ChevronRight className="h-3 w-3" />
            </Button>
            <Button size="icon" className="w-8 h-8 bg-[#18B2B0] text-white text-xs">1</Button>
            <Button variant="outline" size="icon" className="w-8 h-8 border-[#18B2B0]/30 text-[#6B7280]" disabled>
              <ChevronLeft className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl p-4 flex items-center justify-between border border-[rgba(24,178,176,0.18)] bg-white">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-[#18B2B0]/10 text-[#18B2B0]">
              <RefreshCw className="h-4 w-4" />
            </div>
            <p className="text-xs text-[#6B7280]">{t('common.data_5')}</p>
          </div>
          <button className="text-[10px] font-bold text-[#18B2B0] underline underline-offset-4">{t('common.update_2')}</button>
        </div>
        <div className="rounded-xl p-4 flex items-center justify-between border border-[rgba(24,178,176,0.18)] bg-white">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-[#18B2B0]/10 text-[#18B2B0]">
              <Boxes className="h-4 w-4" />
            </div>
            <p className="text-xs text-[#6B7280]">{t('common.technician_7')}</p>
          </div>
          <button className="text-[10px] font-bold text-[#18B2B0] underline underline-offset-4">{t('common.item_20697')}</button>
        </div>
      </div>

      {/* Details Dialog for Scanned Devices / Transfers */}
      <Dialog open={!!selectedRow} onOpenChange={(open) => !open && setSelectedRow(null)}>
        <DialogContent className="sm:max-w-2xl bg-white border border-[rgba(24,178,176,0.22)] text-[#2D3135] p-6 rounded-2xl max-h-[90vh] overflow-y-auto shadow-xl" dir={dir}>
          <DialogHeader className="text-right border-b border-[#E6E8EC] pb-4 mb-4">
            <div className="flex items-start gap-3">
              {selectedRow ? (
                <div className="shrink-0 scale-125 origin-top">
                  {renderProductImage(selectedRow)}
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-xl font-bold flex items-center gap-2 text-[#2D3135]">
                  <Smartphone className="w-5 h-5 text-[#18B2B0]" />
                  {selectedRow?.type === "device" ? t('common.details_device_sim') : t('common.details_transaction_inventory')}
                </DialogTitle>
                <DialogDescription className="text-[#6B7280] text-xs mt-1">
                  {selectedRow?.type === "device" 
                    ? t('common.track_details_1')
                    : t('common.view_details_document_transfer')}
                </DialogDescription>
                {selectedRow?.productName ? (
                  <p className="text-sm font-semibold text-[#18B2B0] mt-1.5">{selectedRow.productName}</p>
                ) : null}
              </div>
            </div>
          </DialogHeader>

          {selectedRow?.type === "device" ? (
            <div className="space-y-6">
              {/* Stepper/Timeline */}
              <div className="bg-white p-4 rounded-xl border border-[#E2E8F0]/80">
                <div className="relative flex justify-between items-center">
                  {/* Progress Line */}
                  <div className="absolute top-[22px] left-[10%] right-[10%] h-[2px] bg-[#E2E8F0] -z-0">
                    <div 
                      className="h-full bg-emerald-500 transition-all duration-300"
                      style={{
                        width: selectedRow.raw?.status === "delivered" 
                          ? "100%" 
                          : selectedRow.raw?.status === "approved" 
                          ? "66%" 
                          : selectedRow.raw?.status === "rejected"
                          ? "33%"
                          : "0%"
                      }}
                    />
                  </div>

                  {steps.map((step, idx) => {
                    const StepIcon = step.icon;
                    const isCompleted = isStepCompleted(idx, selectedRow.raw);
                    const isActive = activeStepIndex === idx;
                    
                    let stateColor = "text-[#9CA3AF] border-[#E2E8F0] bg-white";
                    if (isActive) {
                      stateColor = "text-[#18B2B0] border-[#18B2B0] bg-[#18B2B0]/10 shadow-md shadow-[#18B2B0]/15";
                    } else if (isCompleted) {
                      stateColor = "text-emerald-600 border-emerald-400 bg-emerald-50";
                    } else if (selectedRow.raw?.status === "rejected" && idx === 1) {
                      stateColor = "text-rose-600 border-rose-400 bg-rose-50";
                    }

                    return (
                      <div key={idx} className="flex-1 flex flex-col items-center relative z-10">
                        <button
                          onClick={() => setActiveStepIndex(idx)}
                          className={`w-11 h-11 rounded-full border-2 flex items-center justify-center transition-all ${stateColor}`}
                        >
                          <StepIcon className="w-4 h-4 shrink-0" />
                        </button>
                        <span className={`text-[11px] mt-1.5 font-bold ${isActive ? "text-[#18B2B0]" : isCompleted ? "text-emerald-400" : "text-[#6B7280]"}`}>
                          {step.title}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Detail Step Box */}
              <div className="bg-white p-5 rounded-xl border border-[#E2E8F0]/80">
                <div className="flex items-center gap-2 mb-4 border-b border-[#E2E8F0]/60 pb-3">
                  {activeStepIndex === 0 && <Activity className="w-4 h-4 text-[#18B2B0]" />}
                  {activeStepIndex === 1 && <ShieldCheck className="w-4 h-4 text-[#18B2B0]" />}
                  {activeStepIndex === 2 && <Boxes className="w-4 h-4 text-[#18B2B0]" />}
                  {activeStepIndex === 3 && <Truck className="w-4 h-4 text-[#18B2B0]" />}
                  <h4 className="text-sm font-bold text-[#4B5563]">
                    {activeStepIndex === 0 && t('common.details_7')}
                    {activeStepIndex === 1 && t('common.supervisor_2')}
                    {activeStepIndex === 2 && t('common.status_10')}
                    {activeStepIndex === 3 && t('common.device_4')}
                  </h4>
                </div>

                <div className="divide-y divide-[#E6E8EC]">
                  {activeStepIndex === 0 && (
                    <>
                      {renderDetailItem(t('common.item_9548'), selectedRow.productName)}
                      {renderDetailItem(t('common.number_serial_3'), selectedRow.serial || selectedRow.raw?.serialNumber, true)}
                      {renderDetailItem(t('common.number_device_2'), selectedRow.raw?.terminalId || "-", true)}
                      {renderDetailItem(t('common.date_scan'), formatDateTime(selectedRow.raw?.createdAt))}
                      {renderDetailItem(t('common.type_warehouse'), selectedRow.raw?.inventoryType === "moving" ? t('common.item_24030') : t('common.item_14327'))}
                    </>
                  )}

                  {activeStepIndex === 1 && (
                    <>
                      {renderDetailItem(t('common.status_5'), 
                        selectedRow.raw?.status === "approved" ? t('common.approved') : 
                        selectedRow.raw?.status === "rejected" ? t('common.rejected') : t('common.pending_review')
                      )}
                      {renderDetailItem(t('common.supervisor_admin'), selectedRow.raw?.approvedBy || t('common.review_1'))}
                      {renderDetailItem(t('common.date_3'), formatDateTime(selectedRow.raw?.approvedAt))}
                      {renderDetailItem(t('common.notes_review'), selectedRow.raw?.adminNotes || t('common.no_10'))}
                    </>
                  )}

                  {activeStepIndex === 2 && (
                    <>
                      {renderDetailItem(t('common.item_25468'), displayTechnicianName)}
                      {renderDetailItem(t('common.status_6'), 
                        (selectedRow.raw?.status === "approved" || selectedRow.raw?.status === "delivered")
                          ? t('common.technician_5') 
                          : t('common.item_35103')
                      )}
                      {renderDetailItem(t('common.type_3'), selectedRow.raw?.inventoryType === "moving" ? t('common.technician_6') : t('common.warehouse_primary'))}
                      {renderDetailItem(t('common.signed_3'), t('common.item_46213'))}
                    </>
                  )}

                  {activeStepIndex === 3 && (
                    <>
                      {renderDetailItem(t('common.status_7'), t('common.completed_successfully_1'))}
                      {renderDetailItem(t('common.name_customer'), t('common.log_2'))}
                      {renderDetailItem(t('common.date_4'), formatDateTime(selectedRow.raw?.updatedAt || selectedRow.raw?.createdAt))}
                      {renderDetailItem(t('common.code_verification'), "OTP-4820", true)}
                      {renderDetailItem(t('common.received_admin'), t('common.manager_branch'))}
                      
                      {/* Customer Signature display */}
                      <div className="py-3 border-b border-[#E2E8F0]/60">
                        <span className="text-[#6B7280] text-xs block mb-2 font-medium">{t('common.signature_digital')}</span>
                        <div className="bg-[#F8FAFB] rounded-xl p-3 border border-[#E6E8EC] flex items-center justify-center h-24 relative overflow-hidden">
                          {/* Signature mock graphic */}
                          <svg className="w-48 h-16 text-[#18B2B0]/80 stroke-current opacity-75" viewBox="0 0 200 60" fill="none" strokeWidth="2" strokeLinecap="round">
                            <path d="M20,40 Q40,10 60,30 T100,20 T140,40 T180,25 Q190,15 170,45" />
                          </svg>
                          <span className="absolute bottom-1.5 right-3 text-[10px] text-[#6B7280] font-mono">{t('common.completed_signature')}</span>
                        </div>
                      </div>

                      {/* Evidence Photo display */}
                      <div className="py-3">
                        <span className="text-[#6B7280] text-xs block mb-2 font-medium">{t('common.image_proof')}</span>
                        <div className="relative rounded-xl border border-[#E6E8EC] overflow-hidden bg-[#F3F4F6] aspect-video flex items-center justify-center">
                          <img 
                            src="https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&q=80&w=400" 
                            alt={t('common.proof')} 
                            className="object-cover w-full h-full opacity-60"
                          />
                          <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />
                          <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between text-[11px] text-white">
                            <span className="font-bold">{t('common.image_device_signed')}</span>
                            <span className="font-mono text-[#6B7280]">TID: {selectedRow.raw?.terminalId || "N/A"}</span>
                          </div>
                        </div>
                      </div>

                      {/* GPS verification map */}
                      <div className="py-3 border-t border-[#E2E8F0]/60 flex items-center justify-between">
                        <div>
                          <span className="text-[#6B7280] text-xs font-medium block">{t('common.verification')}</span>
                          <span className="font-mono text-xs text-[#2D3135] font-bold">24.7136° N, 46.6753° E</span>
                        </div>
                        <Button size="sm" variant="outline" className="border-[#E2E8F0] text-[#18B2B0] hover:bg-[#18B2B0]/5 text-xs">
                          <MapPin className="w-3.5 h-3.5 ml-1" />
                          {t('common.view_3')}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Hardware Diagnostic Profile (If item category is pos/devices) */}
              {(!itemType || itemType.category === "devices") && (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-[#6B7280]">{t('common.technician_4')}</h4>
                  <div className="grid grid-cols-2 gap-3">
                    {renderAccessoryChip(t('common.battery_1'), !!selectedRow.raw?.battery, Smartphone)}
                    {renderAccessoryChip(t('common.item_12740'), !!selectedRow.raw?.chargerCable, Cable)}
                    {renderAccessoryChip(t('common.item_11125'), !!selectedRow.raw?.chargerHead, Plug)}
                    {renderAccessoryChip(
                      selectedRow.raw?.hasSim ? t('common.sim_2', { var_0: selectedRow.raw?.simCardType || "SIM" }) : t('common.sim_3'),
                      !!selectedRow.raw?.hasSim,
                      Smartphone
                    )}
                  </div>
                </div>
              )}

              {/* Damage Report Section */}
              {selectedRow.raw?.damagePart && (
                <div className="p-4 rounded-xl bg-rose-500/5 border border-rose-500/20 flex gap-3 items-start">
                  <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="text-sm font-bold text-rose-700">{t('common.report')}</h5>
                    <p className="text-xs text-rose-400/90 mt-1">{selectedRow.raw.damagePart}</p>
                  </div>
                </div>
              )}

              {/* Inline Supervisor Decisions Form */}
              {selectedRow.raw?.status === "pending" && (
                <div className="mt-6 pt-5 border-t border-[#E2E8F0]">
                  <h5 className="text-sm font-bold text-[#2D3135] mb-3 flex items-center gap-2">
                    <Settings className="w-4 h-4 text-[#18B2B0]" />
                    {t('common.receive')}
                  </h5>
                  <textarea
                    value={adminNotesText}
                    onChange={(e) => setAdminNotesText(e.target.value)}
                    placeholder={t('common.notes_device_1')}
                    className="w-full bg-[#F8FAFB] border border-[#E2E8F0] rounded-xl p-3 text-sm text-[#2D3135] focus:outline-none focus:border-[#18B2B0]/50 mb-4 h-20 placeholder:text-[#9CA3AF]"
                  />
                  <div className="flex gap-3">
                    <Button
                      onClick={() => updateStatusMutation.mutate({ status: "approved", adminNotes: adminNotesText })}
                      disabled={updateStatusMutation.isPending}
                      className="flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-black"
                    >
                      {updateStatusMutation.isPending ? t('common.item_19208') : t('common.approve_device')}
                    </Button>
                    <Button
                      onClick={() => updateStatusMutation.mutate({ status: "rejected", adminNotes: adminNotesText })}
                      disabled={updateStatusMutation.isPending}
                      className="flex-1 bg-rose-500 hover:bg-rose-600 text-white font-bold"
                    >
                      {updateStatusMutation.isPending ? t('common.reject_1') : t('common.reject_request')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Layout for Warehouse Transfer */
            <div className="space-y-4">
              <div className="bg-white p-4 rounded-xl border border-[#E2E8F0]/80 divide-y divide-slate-800/60">
                {renderDetailItem(t('common.item_9548'), selectedRow?.productName || "-")}
                {renderDetailItem(t('common.type_document'), t('common.transfer_4'))}
                {renderDetailItem(t('common.number_document_transfer'), selectedRow?.id || "-", true)}
                {renderDetailItem(t('common.status'), selectedRow?.status || "-")}
                {renderDetailItem(t('common.date'), selectedRow?.datetime || "-")}
                {renderDetailItem(t('common.item_19112'), t('common.warehouse_primary'))}
                {renderDetailItem(t('common.received_1'), displayTechnicianName)}
              </div>
              <div className="p-4 rounded-xl border border-[rgba(24,178,176,0.18)] bg-cyan-400/5 flex gap-3 items-center">
                <Info className="w-5 h-5 text-[#18B2B0] shrink-0" />
                <p className="text-xs text-[#6B7280]">{t('common.log_batch_transfer_warehouse_p')}</p>
              </div>
            </div>
          )}

              <div className="mt-6 flex items-center justify-between gap-3 border-t border-[#E6E8EC] pt-4">
            <div className="flex items-center gap-2">
              {selectedRow?.raw?.id && (
                <Button
                  type="button"
                  variant="default"
                  onClick={() => openEditModal(selectedRow)}
                  className="bg-[#18B2B0] hover:bg-[#149D9B] text-white font-bold text-xs px-4 shadow-sm"
                  data-testid="button-edit-device-dialog"
                >
                  <Pencil className="h-4 w-4 ml-1.5" />
                  تعديل البيانات
                </Button>
              )}
              {selectedRow?.raw?.id && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => requestHardDelete(selectedRow)}
                  className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 font-bold text-xs"
                  data-testid="button-hard-delete-serialized-dialog"
                >
                  <Trash2 className="h-4 w-4 ml-1.5" />
                  حذف نهائياً
                </Button>
              )}
            </div>
            <Button
              type="button"
              onClick={() => setSelectedRow(null)}
              className="bg-[#F3F4F6] hover:bg-[#E5E7EB] text-[#2D3135] border border-[#E2E8F0] font-bold px-6 text-xs"
            >
              {t('common.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Device Dialog */}
      <Dialog open={!!editingRow} onOpenChange={(open) => !open && setEditingRow(null)}>
        <DialogContent className="sm:max-w-md bg-white border border-[rgba(24,178,176,0.22)] text-[#2D3135] p-6 rounded-2xl shadow-xl" dir={dir}>
          <DialogHeader className="text-right border-b border-[#E6E8EC] pb-3 mb-4">
            <DialogTitle className="text-lg font-bold flex items-center gap-2 text-[#2D3135]">
              <Pencil className="w-5 h-5 text-[#18B2B0]" />
              تعديل بيانات {deleteLabelForCategory(itemType?.category)}
            </DialogTitle>
            <DialogDescription className="text-[#6B7280] text-xs mt-1">
              قم بتعديل الرقم التسلسلي، رقم الجهاز، أو الملاحظات ثم اضغط حفظ
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editingRow) return;
              updateDeviceMutation.mutate({
                row: editingRow,
                serialNumber: editSerialNumber,
                terminalId: editTerminalId,
                simCardType: editSimCardType,
                adminNotes: editAdminNotes,
                status: editStatus,
              });
            }}
            className="space-y-4 text-right"
          >
            <div>
              <label className="block text-xs font-bold text-[#4B5563] mb-1.5">اسم المنتج</label>
              <div className="p-2.5 rounded-xl bg-[#F8FAFB] border border-[#E2E8F0] text-xs font-bold text-[#2D3135]">
                {editingRow?.productName || displayItemName}
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#4B5563] mb-1.5">الرقم التسلسلي (Serial Number)</label>
              <Input
                value={editSerialNumber}
                onChange={(e) => setEditSerialNumber(e.target.value)}
                placeholder="أدخل الرقم التسلسلي..."
                className="font-mono text-sm border-[#18B2B0]/40 focus:border-[#18B2B0] bg-white text-[#2D3135]"
                required
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-[#4B5563] mb-1.5">رقم الجهاز (Terminal ID)</label>
              <Input
                value={editTerminalId}
                onChange={(e) => setEditTerminalId(e.target.value)}
                placeholder="رقم TID..."
                className="font-mono text-sm border-[#E2E8F0] focus:border-[#18B2B0] bg-white text-[#2D3135]"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-[#4B5563] mb-1.5">مزود الشريحة / الشبكة</label>
              <Select value={editSimCardType} onValueChange={(val) => setEditSimCardType(val)}>
                <SelectTrigger className="bg-white border-[#E2E8F0] text-xs text-[#2D3135]">
                  <SelectValue placeholder="اختر المشغل..." />
                </SelectTrigger>
                <SelectContent className="bg-white z-[100]">
                  <SelectItem value="STC">STC</SelectItem>
                  <SelectItem value="Zain">Zain</SelectItem>
                  <SelectItem value="Mobily">Mobily</SelectItem>
                  <SelectItem value="Lebara">Lebara</SelectItem>
                  <SelectItem value="Other">أخرى / غير محدد</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#4B5563] mb-1.5">حالة المادة</label>
              <Select value={editStatus} onValueChange={(val) => setEditStatus(val)}>
                <SelectTrigger className="bg-white border-[#E2E8F0] text-xs text-[#2D3135]">
                  <SelectValue placeholder="اختر الحالة..." />
                </SelectTrigger>
                <SelectContent className="bg-white z-[100]">
                  <SelectItem value="approved">في العهدة / متوفر</SelectItem>
                  <SelectItem value="delivered">مكتمل / مسلّم للعميل</SelectItem>
                  <SelectItem value="pending">معلق / قيد المراجعة</SelectItem>
                  <SelectItem value="rejected">مرفوض</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#4B5563] mb-1.5">الملاحظات</label>
              <textarea
                value={editAdminNotes}
                onChange={(e) => setEditAdminNotes(e.target.value)}
                placeholder="أضف أي ملاحظات إضافية..."
                rows={3}
                className="w-full rounded-xl border border-[#E2E8F0] p-3 text-xs text-[#2D3135] bg-white focus:border-[#18B2B0] focus:outline-none placeholder:text-[#9CA3AF]"
              />
            </div>

            <DialogFooter className="flex-row-reverse gap-2 pt-2 border-t border-[#E6E8EC] mt-4">
              <Button
                type="submit"
                disabled={updateDeviceMutation.isPending}
                className="bg-[#18B2B0] hover:bg-[#149D9B] text-white font-bold text-xs px-5 shadow-md shadow-[#18B2B0]/20"
              >
                {updateDeviceMutation.isPending ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 ml-1.5 animate-spin" />
                    جاري الحفظ...
                  </>
                ) : (
                  "حفظ التعديلات"
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditingRow(null)}
                disabled={updateDeviceMutation.isPending}
                className="border-[#E2E8F0] text-[#6B7280] font-bold text-xs"
              >
                إلغاء
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!rowPendingDelete}
        onOpenChange={(open) => {
          if (!open && !hardDeleteSerializedMutation.isPending) {
            setRowPendingDelete(null);
          }
        }}
      >
        <AlertDialogContent className="bg-white border border-[rgba(24,178,176,0.22)]" dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#2D3135]">تأكيد الحذف النهائي</AlertDialogTitle>
            <AlertDialogDescription className="text-[#6B7280]">
              {`هل أنت متأكد من حذف ${deleteLabelForCategory(itemType?.category)} نهائياً من قاعدة البيانات؟`}
              {rowPendingDelete?.serial && rowPendingDelete.serial !== "-" ? (
                <span className="block mt-2 font-mono text-[#18B2B0] text-sm" dir="ltr">
                  {rowPendingDelete.serial}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700 text-white font-bold"
              disabled={hardDeleteSerializedMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!rowPendingDelete) return;
                hardDeleteSerializedMutation.mutate(rowPendingDelete);
              }}
            >
              {hardDeleteSerializedMutation.isPending ? "جاري الحذف..." : "حذف نهائياً"}
            </AlertDialogAction>
            <AlertDialogCancel disabled={hardDeleteSerializedMutation.isPending}>
              إلغاء
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
