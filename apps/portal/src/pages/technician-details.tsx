import { useTranslation, t } from "@/lib/language";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { useMemo, useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  ChevronLeft,
  Download,
  Handshake,
  MapPin,
  RefreshCw,
  Search,
  Truck,
  Warehouse,
  XCircle,
  CheckCircle,
  XCircle as XCircleIcon,
  Copy,
  Check,
  Smartphone,
  Cable,
  Plug,
  AlertCircle,
  Activity,
  FileText,
  ShieldCheck,
  Settings,
  Trash2,
} from "lucide-react";
import { exportTechnicianToExcel } from "@/lib/exportToExcel";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useActiveItemTypes } from "@/hooks/use-item-types";
import type { TechnicianFixedInventoryEntry, TechnicianMovingInventoryEntry } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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

interface TechnicianFixedInventory {
  id: string;
  technicianId: string;
  technicianName?: string;
  city?: string;
  n950Boxes: number;
  n950Units: number;
  i9000sBoxes: number;
  i9000sUnits: number;
  i9100Boxes: number;
  i9100Units: number;
  rollPaperBoxes: number;
  rollPaperUnits: number;
  stickersBoxes: number;
  stickersUnits: number;
  newBatteriesBoxes: number;
  newBatteriesUnits: number;
  mobilySimBoxes: number;
  mobilySimUnits: number;
  stcSimBoxes: number;
  stcSimUnits: number;
  zainSimBoxes: number;
  zainSimUnits: number;
  lebaraBoxes: number;
  lebaraUnits: number;
}

interface TechnicianMovingInventory {
  id: string;
  technicianName?: string;
  city?: string;
  n950Boxes: number;
  n950Units: number;
  i9000sBoxes: number;
  i9000sUnits: number;
  i9100Boxes: number;
  i9100Units: number;
  rollPaperBoxes: number;
  rollPaperUnits: number;
  stickersBoxes: number;
  stickersUnits: number;
  newBatteriesBoxes: number;
  newBatteriesUnits: number;
  mobilySimBoxes: number;
  mobilySimUnits: number;
  stcSimBoxes: number;
  stcSimUnits: number;
  zainSimBoxes: number;
  zainSimUnits: number;
  lebaraBoxes: number;
  lebaraUnits: number;
}

interface LegacyInventoryPayload {
  n950Boxes: number;
  n950Units: number;
  i9000sBoxes: number;
  i9000sUnits: number;
  i9100Boxes: number;
  i9100Units: number;
  rollPaperBoxes: number;
  rollPaperUnits: number;
  stickersBoxes: number;
  stickersUnits: number;
  newBatteriesBoxes: number;
  newBatteriesUnits: number;
  mobilySimBoxes: number;
  mobilySimUnits: number;
  stcSimBoxes: number;
  stcSimUnits: number;
  zainSimBoxes: number;
  zainSimUnits: number;
  lebaraBoxes: number;
  lebaraUnits: number;
}

interface ProductInfo {
  id: string;
  nameAr: string;
  nameEn: string;
  fixedBoxes: number;
  fixedUnits: number;
  fixedTotal: number;
  movingBoxes: number;
  movingUnits: number;
  movingTotal: number;
  grandTotal: number;
  icon: any;
  color: string;
}

type InventoryEntryLike = {
  itemTypeId: string;
  boxes: number;
  units: number;
};

type TechnicianWithBothInventories = {
  technicianId: string;
  technicianName: string;
  city: string;
  fixedInventory: (Partial<TechnicianFixedInventory> & { entries?: InventoryEntryLike[] }) | null;
  movingInventory: (Partial<TechnicianMovingInventory> & { entries?: InventoryEntryLike[] }) | null;
};

type ReceivedDevice = {
  id: string;
  terminalId: string;
  serialNumber: string;
  itemTypeId: string | null;
  status: "pending" | "approved" | "rejected" | "delivered";
  createdAt: string;
  updatedAt?: string;
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

type InventoryTab = "all" | "fixed" | "moving";

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

function toLegacyInventoryPayload(
  inventory?: Partial<LegacyInventoryPayload> | null,
): LegacyInventoryPayload {
  return {
    n950Boxes: inventory?.n950Boxes ?? 0,
    n950Units: inventory?.n950Units ?? 0,
    i9000sBoxes: inventory?.i9000sBoxes ?? 0,
    i9000sUnits: inventory?.i9000sUnits ?? 0,
    i9100Boxes: inventory?.i9100Boxes ?? 0,
    i9100Units: inventory?.i9100Units ?? 0,
    rollPaperBoxes: inventory?.rollPaperBoxes ?? 0,
    rollPaperUnits: inventory?.rollPaperUnits ?? 0,
    stickersBoxes: inventory?.stickersBoxes ?? 0,
    stickersUnits: inventory?.stickersUnits ?? 0,
    newBatteriesBoxes: inventory?.newBatteriesBoxes ?? 0,
    newBatteriesUnits: inventory?.newBatteriesUnits ?? 0,
    mobilySimBoxes: inventory?.mobilySimBoxes ?? 0,
    mobilySimUnits: inventory?.mobilySimUnits ?? 0,
    stcSimBoxes: inventory?.stcSimBoxes ?? 0,
    stcSimUnits: inventory?.stcSimUnits ?? 0,
    zainSimBoxes: inventory?.zainSimBoxes ?? 0,
    zainSimUnits: inventory?.zainSimUnits ?? 0,
    lebaraBoxes: inventory?.lebaraBoxes ?? 0,
    lebaraUnits: inventory?.lebaraUnits ?? 0,
  };
}

function getStockStatus(total: number): { label: string; className: string } {
  if (total <= 0) {
    return {
      label: t('common.item_14365'),
      className: "bg-rose-50 text-rose-700 border border-rose-200",
    };
  }

  if (total < 10) {
    return {
      label: t('common.item_7984'),
      className: "bg-amber-50 text-amber-800 border border-amber-200",
    };
  }

  if (total < 40) {
    return {
      label: t('common.active_1'),
      className: "bg-[#18B2B0]/10 text-[#149D9B] border border-[#18B2B0]/30",
    };
  }

  return {
    label: t('common.item_15929'),
    className: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  };
}

export default function TechnicianDetailsPage() {
  const { t, dir, formatNumber } = useTranslation();
  const [, params] = useRoute("/technician-details/:id");
  const technicianId = params?.id;
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canSeeTechniciansInventory = user?.role === "admin" || user?.role === "supervisor";
  const canHardDeleteSerialized = user?.role === "admin";

  const [activeTab, setActiveTab] = useState<InventoryTab>("all");
  const [activeSerialTab, setActiveSerialTab] = useState<"active" | "history">("active");
  const [searchTerm, setSearchTerm] = useState("");

  // Scanned Device Modal & Approval states
  const [selectedDevice, setSelectedDevice] = useState<ReceivedDevice | null>(null);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [adminNotesText, setAdminNotesText] = useState<string>("");
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [itemPendingDelete, setItemPendingDelete] = useState<any | null>(null);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const {
    data: techniciansWithInventory,
    isLoading: isLoadingTechniciansInventory,
  } = useQuery<{ technicians: TechnicianWithBothInventories[] }>({
    queryKey:
      user?.role === "admin"
        ? ["/api/admin/all-technicians-inventory"]
        : ["/api/supervisor/technicians-inventory"],
    enabled: !!technicianId && canSeeTechniciansInventory,
  });

  const { data: fixedInventory, isLoading: isLoadingFixed } = useQuery<TechnicianFixedInventory>({
    queryKey: [`/api/technician-fixed-inventory/${technicianId}`],
    enabled: !!technicianId,
  });

  const { data: movingInventory, isLoading: isLoadingMoving } = useQuery<TechnicianMovingInventory>({
    queryKey: [`/api/supervisor/users/${technicianId}/moving-inventory`],
    enabled: !!technicianId && user?.role === "supervisor",
  });

  const { data: technicianProfile, isLoading: isLoadingProfile } = useQuery<{
    id: string;
    fullName?: string;
    city?: string;
  }>({
    queryKey: [`/api/technicians/${technicianId}`],
    enabled: !!technicianId,
  });

  const { data: itemTypes } = useActiveItemTypes();

  const { data: fixedEntries, isLoading: isLoadingFixedEntries } = useQuery<TechnicianFixedInventoryEntry[]>({
    queryKey: [`/api/technicians/${technicianId}/fixed-inventory-entries`],
    enabled: !!technicianId,
  });

  const { data: movingEntries, isLoading: isLoadingMovingEntries } = useQuery<TechnicianMovingInventoryEntry[]>({
    queryKey: [`/api/technicians/${technicianId}/moving-inventory-entries`],
    enabled: !!technicianId,
  });

  const { data: receivedDevices = [], refetch: refetchReceived } = useQuery<ReceivedDevice[]>({
    queryKey: ["/api/received-devices"],
    enabled: !!technicianId,
  });

  const { data: serializedItems = [], isLoading: isLoadingSerializedItems } = useQuery<any[]>({
    queryKey: [`/api/technicians/${technicianId}/serialized-items`],
    enabled: !!technicianId,
  });

  const { data: deliveredItems = [], isLoading: isLoadingDeliveredItems } = useQuery<any[]>({
    queryKey: [`/api/technicians/${technicianId}/delivered-items`],
    enabled: !!technicianId,
  });

  const legacyDeliveredDevices = useMemo(
    () => receivedDevices.filter((d) => d.technicianId === technicianId && d.status === "delivered"),
    [receivedDevices, technicianId]
  );

  const deliveryLogCount = deliveredItems.length + legacyDeliveredDevices.length;

  const isLoading =
    isLoadingTechniciansInventory ||
    isLoadingFixed ||
    isLoadingMoving ||
    isLoadingProfile ||
    isLoadingFixedEntries ||
    isLoadingMovingEntries ||
    isLoadingSerializedItems ||
    isLoadingDeliveredItems;

  const selectedTechnician = useMemo(() => {
    if (!technicianId) {
      return null;
    }

    return (
      techniciansWithInventory?.technicians?.find((technician) => technician.technicianId === technicianId) || null
    );
  }, [techniciansWithInventory?.technicians, technicianId]);

  const effectiveFixedInventory = selectedTechnician?.fixedInventory || fixedInventory;
  const effectiveMovingInventory = selectedTechnician?.movingInventory || movingInventory;

  const technicianName =
    selectedTechnician?.technicianName ||
    technicianProfile?.fullName ||
    effectiveFixedInventory?.technicianName ||
    effectiveMovingInventory?.technicianName ||
    t('common.item_12813');

  const city = selectedTechnician?.city || effectiveFixedInventory?.city || effectiveMovingInventory?.city || technicianProfile?.city || t('common.item_9568_1');

  const legacyFieldMapping: Record<string, { boxes: string; units: string }> = {
    n950: { boxes: "n950Boxes", units: "n950Units" },
    i9000s: { boxes: "i9000sBoxes", units: "i9000sUnits" },
    i9100: { boxes: "i9100Boxes", units: "i9100Units" },
    rollPaper: { boxes: "rollPaperBoxes", units: "rollPaperUnits" },
    stickers: { boxes: "stickersBoxes", units: "stickersUnits" },
    newBatteries: { boxes: "newBatteriesBoxes", units: "newBatteriesUnits" },
    mobilySim: { boxes: "mobilySimBoxes", units: "mobilySimUnits" },
    stcSim: { boxes: "stcSimBoxes", units: "stcSimUnits" },
    zainSim: { boxes: "zainSimBoxes", units: "zainSimUnits" },
    lebaraSim: { boxes: "lebaraBoxes", units: "lebaraUnits" },
  };

  const categoryIconMap: Record<string, any> = {
    devices: Smartphone,
    papers: FileText,
    accessories: Cable,
    sim: Handshake,
    other: Boxes,
  };

  const categoryColorMap: Record<string, string[]> = {
    devices: ["#3b82f6", "#8b5cf6", "#ec4899", "#6366f1"],
    papers: ["#f59e0b", "#14b8a6"],
    accessories: ["#10b981", "#84cc16"],
    sim: ["#06b6d4", "#6366f1", "#f97316", "#ec4899", "#8b5cf6"],
    other: ["#6b7280"],
  };

  const products: ProductInfo[] = useMemo(() => {
    if (!itemTypes || itemTypes.length === 0) {
      return [];
    }

    const fixedEntryMap = new Map((fixedEntries || []).map((entry) => [entry.itemTypeId, entry]));
    const movingEntryMap = new Map((movingEntries || []).map((entry) => [entry.itemTypeId, entry]));

    return itemTypes
      .filter((itemType) => itemType.isActive && itemType.isVisible)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((itemType, index) => {
        const fixedEntry = fixedEntryMap.get(itemType.id);
        const movingEntry = movingEntryMap.get(itemType.id);
        const legacy = legacyFieldMapping[itemType.id];
        const preferSnapshot = Boolean(selectedTechnician);

        let fixedBoxes = 0;
        let fixedUnits = 0;
        let movingBoxes = 0;
        let movingUnits = 0;

        const fixedInventoryEntry = Array.isArray(effectiveFixedInventory)
          ? (effectiveFixedInventory as InventoryEntryLike[]).find((entry) => entry.itemTypeId === itemType.id)
          : Array.isArray((effectiveFixedInventory as any)?.entries)
          ? ((effectiveFixedInventory as any).entries as InventoryEntryLike[]).find((entry) => entry.itemTypeId === itemType.id)
          : undefined;

        const movingInventoryEntry = Array.isArray(effectiveMovingInventory)
          ? (effectiveMovingInventory as InventoryEntryLike[]).find((entry) => entry.itemTypeId === itemType.id)
          : Array.isArray((effectiveMovingInventory as any)?.entries)
          ? ((effectiveMovingInventory as any).entries as InventoryEntryLike[]).find((entry) => entry.itemTypeId === itemType.id)
          : undefined;

        if (preferSnapshot) {
          if (fixedInventoryEntry) {
            fixedBoxes = Number(fixedInventoryEntry.boxes || 0);
            fixedUnits = Number(fixedInventoryEntry.units || 0);
          } else if (legacy && effectiveFixedInventory) {
            fixedBoxes = Number((effectiveFixedInventory as any)[legacy.boxes] || 0);
            fixedUnits = Number((effectiveFixedInventory as any)[legacy.units] || 0);
          } else if (fixedEntry) {
            fixedBoxes = Number(fixedEntry.boxes || 0);
            fixedUnits = Number(fixedEntry.units || 0);
          }

          if (movingInventoryEntry) {
            movingBoxes = Number(movingInventoryEntry.boxes || 0);
            movingUnits = Number(movingInventoryEntry.units || 0);
          } else if (legacy && effectiveMovingInventory) {
            movingBoxes = Number((effectiveMovingInventory as any)[legacy.boxes] || 0);
            movingUnits = Number((effectiveMovingInventory as any)[legacy.units] || 0);
          } else if (movingEntry) {
            movingBoxes = Number(movingEntry.boxes || 0);
            movingUnits = Number(movingEntry.units || 0);
          }
        } else {
          if (fixedEntry) {
            fixedBoxes = Number(fixedEntry.boxes || 0);
            fixedUnits = Number(fixedEntry.units || 0);
          } else if (fixedInventoryEntry) {
            fixedBoxes = Number(fixedInventoryEntry.boxes || 0);
            fixedUnits = Number(fixedInventoryEntry.units || 0);
          } else if (legacy && effectiveFixedInventory) {
            fixedBoxes = Number((effectiveFixedInventory as any)[legacy.boxes] || 0);
            fixedUnits = Number((effectiveFixedInventory as any)[legacy.units] || 0);
          }

          if (movingEntry) {
            movingBoxes = Number(movingEntry.boxes || 0);
            movingUnits = Number(movingEntry.units || 0);
          } else if (movingInventoryEntry) {
            movingBoxes = Number(movingInventoryEntry.boxes || 0);
            movingUnits = Number(movingInventoryEntry.units || 0);
          } else if (legacy && effectiveMovingInventory) {
            movingBoxes = Number((effectiveMovingInventory as any)[legacy.boxes] || 0);
            movingUnits = Number((effectiveMovingInventory as any)[legacy.units] || 0);
          }
        }

        if (itemType.requiresSerial || itemType.category === 'sim' || itemType.category === 'devices') {
          // Serialized types (devices/SIMs) have no real concept of bulk "fixed" stock —
          // every real unit is a row in the serialized items table. Any leftover value in
          // technician_fixed_inventory_entries for these types is stale/erroneous manual
          // data entry with no serial backing it, so it must never be shown as real stock.
          movingUnits = (serializedItems || []).filter((item: any) => item.itemTypeId === itemType.id).length;
          movingBoxes = 0;
          fixedBoxes = 0;
          fixedUnits = 0;
        }

        const colors = categoryColorMap[itemType.category] || categoryColorMap.other;

        return {
          id: itemType.id,
          nameAr: itemType.nameAr,
          nameEn: itemType.nameEn,
          category: itemType.category,
          fixedBoxes,
          fixedUnits,
          fixedTotal: fixedBoxes + fixedUnits,
          movingBoxes,
          movingUnits,
          movingTotal: movingBoxes + movingUnits,
          grandTotal: fixedBoxes + fixedUnits + movingBoxes + movingUnits,
          icon: categoryIconMap[itemType.category] || categoryIconMap.other,
          color: colors[index % colors.length],
        };
      });
  }, [itemTypes, effectiveFixedInventory, effectiveMovingInventory, fixedEntries, movingEntries, selectedTechnician, serializedItems]);

  const totalFixed = products.reduce((sum, product) => sum + product.fixedTotal, 0);
  const totalMoving = products.reduce((sum, product) => sum + product.movingTotal, 0);
  const grandTotal = totalFixed + totalMoving;

  const totalBoxes = products.reduce((sum, product) => sum + product.fixedBoxes + product.movingBoxes, 0);
  const movingBoxes = products.reduce((sum, product) => sum + product.movingBoxes, 0);

  const hasAnyData = Boolean(
    technicianProfile ||
      selectedTechnician ||
      effectiveFixedInventory ||
      effectiveMovingInventory ||
      (fixedEntries?.length ?? 0) > 0 ||
      (movingEntries?.length ?? 0) > 0,
  );

  const fixedShare = grandTotal > 0 ? (totalFixed / grandTotal) * 100 : 0;
  const movingShare = grandTotal > 0 ? (totalMoving / grandTotal) * 100 : 0;
  const movingBoxesShare = totalBoxes > 0 ? (movingBoxes / totalBoxes) * 100 : 0;

  const rowsByTab = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();

    const buildRows = (tab: InventoryTab) => {
      return products
        .map((product) => {
          if (tab === "fixed") {
            return {
              ...product,
              boxes: product.fixedBoxes,
              units: product.fixedUnits,
              total: product.fixedTotal,
            };
          }

          if (tab === "moving") {
            return {
              ...product,
              boxes: product.movingBoxes,
              units: product.movingUnits,
              total: product.movingTotal,
            };
          }

          return {
            ...product,
            boxes: product.fixedBoxes + product.movingBoxes,
            units: product.fixedUnits + product.movingUnits,
            total: product.grandTotal,
          };
        })
        .filter((row) => {
          if (!search) return true;

          return (
            row.nameAr.toLowerCase().includes(search) ||
            row.nameEn.toLowerCase().includes(search)
          );
        });
    };

    return {
      all: buildRows("all"),
      fixed: buildRows("fixed"),
      moving: buildRows("moving"),
    };
  }, [products, searchTerm]);

  const lowStockAlertsCount = products.filter((product) => product.grandTotal < 10).length;
  const inventoryAccuracy =
    products.length > 0 ? (products.filter((product) => product.grandTotal > 0).length / products.length) * 100 : 0;

  const canTransferToWarehouse = user?.role === "admin" || user?.role === "supervisor";

  const handleExport = async () => {
    try {
      await exportTechnicianToExcel({
        technicianName,
        city,
        itemTypes: (itemTypes || []).map((itemType) => ({
          id: itemType.id,
          nameAr: itemType.nameAr,
          nameEn: itemType.nameEn,
        })),
        fixedEntries: fixedEntries || [],
        movingEntries: movingEntries || [],
        fixedInventory: toLegacyInventoryPayload(effectiveFixedInventory),
        movingInventory: toLegacyInventoryPayload(effectiveMovingInventory),
      });

      toast({
        title: t('common.completed_export_successfully'),
        description: t('common.completed_file_technician'),
      });
    } catch (error) {
      toast({
        title: t('common.fail_export'),
        description: t('common.error_export_data'),
        variant: "destructive",
      });
    }
  };

  const updateStatusMutation = useMutation({
    mutationFn: async ({ status, adminNotes }: { status: "approved" | "rejected"; adminNotes: string }) => {
      if (!selectedDevice?.id) return;
      const res = await apiRequest("PATCH", `/api/received-devices/${selectedDevice.id}/status`, {
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
      refetchReceived();
      setSelectedDevice(null);
    },
    onError: (err: any) => {
      toast({
        title: t('common.fail_update_status'),
        description: err.message || t('common.error_2'),
        variant: "destructive",
      });
    },
  });

  const isStepCompleted = (stepIndex: number, device: ReceivedDevice) => {
    const status = (device.status || "").toLowerCase();
    switch (stepIndex) {
      case 0:
        return true;
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
    <div className="flex justify-between items-center py-2.5 border-b border-[#E2E8F0]/60 last:border-0 text-sm">
      <span className="text-slate-400 font-medium">{label}</span>
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
      ? "border-emerald-200 bg-emerald-50 text-emerald-700" 
      : "border-[#E2E8F0] bg-[#F8FAFC] text-[#6B7280]";
    return (
      <div className={`flex items-center justify-between p-3 rounded-xl border ${colorClass} transition-all`}>
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 shrink-0" />
          <span className="text-xs font-bold">{label}</span>
        </div>
        {isPresent ? <CheckCircle className="w-4 h-4 shrink-0" /> : <XCircleIcon className="w-4 h-4 shrink-0" />}
      </div>
    );
  };

  const getProductImage = (item: { category?: string; nameAr?: string; nameEn?: string }) => {
    const category = item.category || "";
    const nameAr = item.nameAr || "";
    const nameEn = item.nameEn || "";
    const name = (nameAr + " " + nameEn).toLowerCase();

    if (category === "stickers" || name.includes(t('common.sticker')) || name.includes("sticker") || name.includes("mol") || name.includes("label") || name.includes(t('common.stickers_1')) || name.includes("stickers")) {
      return "/assets/mol.png";
    } else if (category === "sim") {
      if (name.includes("stc") || name.includes(t('common.item_9611'))) {
        return "/assets/stc.jpg";
      } else if (name.includes("zain") || name.includes(t('common.zain'))) {
        return "/assets/zein.png";
      } else if (name.includes("mobily") || name.includes(t('common.mobily'))) {
        return "/assets/mobile.png";
      } else if (name.includes("lebara") || name.includes(t('common.lebara'))) {
        return "/assets/libar.png";
      }
    } else if (category === "devices" || name.includes("950") || name.includes("9100") || name.includes("9000") || name.includes("pos")) {
      return "/assets/1.png";
    }
    return null;
  };

  const renderProductImage = (category: string, nameAr: string, nameEn: string, extraText?: string | null) => {
    const name = (nameAr + " " + nameEn + " " + (extraText || "")).toLowerCase();

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
    } else if (name.includes("950") || name.includes("9100") || name.includes("9000") || name.includes("pos")) {
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
    }

    return (
      <div className={`relative w-12 h-12 rounded-xl border bg-gradient-to-tr ${gradient} flex flex-col items-center justify-center shadow-sm overflow-hidden shrink-0 group-hover:scale-105 transition-transform duration-200`}>
        <div className="absolute inset-0 bg-white/40 opacity-0 group-hover:opacity-100 transition-opacity" />
        
        {imageSrc ? (
          <img src={imageSrc} alt={brandText || category} className="w-10 h-10 object-contain" />
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

  const technicianInitials = useMemo(() => {
    const parts = (technicianName || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return t('common.item_1567');
    if (parts.length === 1) return parts[0].slice(0, 2);
    return `${parts[0][0] || ""}${parts[1][0] || ""}`;
  }, [technicianName]);

  if (isLoading) {
    return (
      <div className="space-y-6" dir={dir}>
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

  if (!hasAnyData) {
    return (
      <div className="rassco-page rassco-light-surface rounded-2xl border border-rose-200 bg-white p-12 text-center shadow-sm" dir={dir}>
        <XCircle className="h-14 w-14 text-red-400 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-white mb-2">{t('common.data_4')}</h2>
        <p className="text-slate-400 mb-6">{t('common.no_data_technician')}</p>
        <Link href="/home">
          <Button className="bg-[#18B2B0] hover:bg-[#149D9B] text-white font-bold">
            <ArrowLeft className="ml-2 h-4 w-4" />
            {t('common.control')}
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="rassco-page rassco-light-surface space-y-8" dir={dir}>
      {/* Page header — matches item details */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-[#18B2B0]/35 bg-[#18B2B0]/12 text-lg font-black tracking-wide text-[#18B2B0] shadow-sm">
            {technicianInitials}
          </div>
          <div>
            <h2 className="text-3xl font-black text-[#2D3135] tracking-tight">{technicianName}</h2>
            <p className="text-slate-400 mt-1 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-[#18B2B0]" />
                {city || t("common.city")}
              </span>
              <span className="text-[#9CA3AF]">·</span>
              <span>{t("inventory.technician_3")}</span>
            </p>
            <p className="text-xs text-[#18B2B0] mt-1">
              {t("common.active_custody_count", { count: formatNumber(serializedItems.length) })}
              {" · "}
              {t("common.delivered_count_label", { count: formatNumber(deliveryLogCount) })}
            </p>
          </div>
        </div>
        <div className="flex gap-3 flex-wrap">
          {canTransferToWarehouse ? (
            <Link href="/operations">
              <Button className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#18B2B0] text-white font-bold text-sm hover:opacity-90 transition-all shadow-lg shadow-[#18B2B0]/20">
                <Truck className="h-4 w-4" />
                {t("common.transfer_1")}
              </Button>
            </Link>
          ) : null}
          <Button
            onClick={handleExport}
            variant="outline"
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#18B2B0]/10 text-[#18B2B0] border-[#18B2B0]/30 font-bold text-sm hover:bg-[#18B2B0]/15"
            data-testid="button-export"
          >
            <Download className="h-4 w-4" />
            {t("inventory.export_excel")}
          </Button>
          <Link href="/admin-inventory-overview">
            <Button variant="outline" className="inline-flex items-center gap-2 border-[#E2E8F0] text-[#4B5563] hover:bg-[rgba(24,178,176,0.06)]">
              <ArrowLeft className="h-4 w-4 shrink-0" />
              {t("common.item_6366")}
            </Button>
          </Link>
        </div>
      </div>

      {/* KPI cards — same Card pattern as item page */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="bg-white border-[rgba(24,178,176,0.18)] shadow-sm">
          <CardContent className="p-6">
            <p className="text-[#6B7280] text-sm font-medium mb-2">{t("common.total_inventory")}</p>
            <div className="flex items-end gap-3">
              <h3 className="text-3xl font-black text-[#2D3135] tabular-nums" dir="ltr">
                {formatNumber(grandTotal)}
              </h3>
              <span className="text-emerald-400 text-sm font-bold flex items-center gap-1 mb-1">
                {formatNumber(Number(inventoryAccuracy.toFixed(1)))}%
              </span>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-white border-[rgba(24,178,176,0.18)] shadow-sm">
          <CardContent className="p-6">
            <p className="text-[#6B7280] text-sm font-medium mb-2">{t("common.boxes_1")}</p>
            <div className="flex items-end gap-3">
              <h3 className="text-3xl font-black text-[#2D3135] tabular-nums" dir="ltr">
                {formatNumber(totalBoxes)}
              </h3>
              <span className="text-[#18B2B0] text-xs font-bold mb-1">
                {formatNumber(Number(movingBoxesShare.toFixed(1)))}%
              </span>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-white border-[rgba(24,178,176,0.18)] shadow-sm">
          <CardContent className="p-6">
            <p className="text-[#6B7280] text-sm font-medium mb-2">{t("common.item_22330")}</p>
            <div className="flex items-end gap-3">
              <h3 className="text-3xl font-black text-[#2D3135] tabular-nums" dir="ltr">
                {formatNumber(totalFixed)}
              </h3>
              <span className="text-[#18B2B0] text-xs font-bold mb-1">
                {formatNumber(Number(fixedShare.toFixed(1)))}%
              </span>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-white border-orange-200 shadow-sm">
          <CardContent className="p-6">
            <p className="text-[#6B7280] text-sm font-medium mb-2">{t("common.item_24017")}</p>
            <div className="flex items-end gap-3">
              <h3 className="text-3xl font-black text-[#2D3135] tabular-nums" dir="ltr">
                {formatNumber(totalMoving)}
              </h3>
              <span className="text-orange-400 text-sm font-bold flex items-center gap-1 mb-1">
                <AlertTriangle className="h-3 w-3" />
                {formatNumber(Number(movingShare.toFixed(1)))}%
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="mb-2">
        <div className="relative group max-w-md">
          <div className="absolute inset-y-0 end-0 flex items-center pe-4 pointer-events-none">
            <Search className="h-4 w-4 text-[#18B2B0]/70" />
          </div>
          <Input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            className="w-full py-3 pe-11 ps-4 rounded-xl text-sm text-[#2D3135] bg-white border-[#18B2B0]/30"
            placeholder={t("common.search_12")}
          />
        </div>
      </div>

      {/* Inventory tabs + table */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as InventoryTab)}
        className="w-full"
      >
        <TabsList className="bg-transparent border-b border-[rgba(24,178,176,0.18)] mb-6 rounded-none p-0 h-auto gap-8 w-full justify-start">
          <TabsTrigger
            value="all"
            className="inline-flex items-center justify-center gap-2 pb-4 px-2 border-b-2 border-transparent data-[state=active]:border-[#18B2B0] data-[state=active]:text-[#18B2B0] text-[#6B7280] rounded-none leading-none"
          >
            <Boxes className="h-4 w-4 shrink-0" />
            {t("common.all")}
          </TabsTrigger>
          <TabsTrigger
            value="fixed"
            className="inline-flex items-center justify-center gap-2 pb-4 px-2 border-b-2 border-transparent data-[state=active]:border-[#18B2B0] data-[state=active]:text-[#18B2B0] text-[#6B7280] rounded-none leading-none"
          >
            <Warehouse className="h-4 w-4 shrink-0" />
            {t("common.item_6308")}
          </TabsTrigger>
          <TabsTrigger
            value="moving"
            className="inline-flex items-center justify-center gap-2 pb-4 px-2 border-b-2 border-transparent data-[state=active]:border-[#18B2B0] data-[state=active]:text-[#18B2B0] text-[#6B7280] rounded-none leading-none"
          >
            <Truck className="h-4 w-4 shrink-0" />
            {t("common.item_7952")}
          </TabsTrigger>
        </TabsList>

        {(["all", "fixed", "moving"] as InventoryTab[]).map((tab) => {
          const rows = rowsByTab[tab];
          return (
            <TabsContent value={tab} key={tab} className="m-0">
              <div className="rounded-xl overflow-hidden border border-[rgba(24,178,176,0.18)] shadow-sm bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-start border-collapse">
                    <thead>
                      <tr className="bg-[#F3F4F6] border-b border-[#E6E8EC]">
                        <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider">{t("common.name_6")}</th>
                        <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.boxes")}</th>
                        <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.units_1")}</th>
                        <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.total_2")}</th>
                        <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.status")}</th>
                        <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.item_14214")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E6E8EC]">
                      {rows.length === 0 ? (
                        <tr>
                          <td className="px-6 py-8 text-center text-[#6B7280]" colSpan={6}>
                            {t("common.no_results_1")}
                          </td>
                        </tr>
                      ) : (
                        rows.map((row) => {
                          const ItemIcon = row.icon;
                          const status = getStockStatus(row.total);
                          const imageUrl = getProductImage(row);
                          return (
                            <tr
                              key={row.id}
                              className="hover:bg-cyan-400/5 transition-colors group"
                            >
                              <td className="px-6 py-5">
                                <div className="flex items-center gap-3">
                                  <div
                                    className="relative w-12 h-12 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-center overflow-hidden shrink-0 group-hover:scale-105 transition-transform duration-200"
                                    style={{ color: row.color }}
                                  >
                                    {imageUrl ? (
                                      <img src={imageUrl} alt={row.nameAr} className="w-10 h-10 object-contain" />
                                    ) : (
                                      <ItemIcon className="w-5 h-5" />
                                    )}
                                  </div>
                                  <div>
                                    <p className="text-sm font-bold text-[#2D3135] group-hover:text-[#18B2B0] transition-colors">
                                      {row.nameAr}
                                    </p>
                                    <p className="text-[10px] text-[#6B7280]">{row.nameEn}</p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-5 text-center tabular-nums text-[#4B5563]" dir="ltr">
                                {formatNumber(row.boxes)}
                              </td>
                              <td className="px-6 py-5 text-center tabular-nums text-[#4B5563]" dir="ltr">
                                {formatNumber(row.units)}
                              </td>
                              <td className="px-6 py-5 text-center text-base font-black tabular-nums text-[#2D3135]" dir="ltr">
                                {formatNumber(row.total)}
                              </td>
                              <td className="px-6 py-5 text-center">
                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold border ${status.className}`}>
                                  {status.label}
                                </span>
                              </td>
                              <td className="px-6 py-5 text-center">
                                <Button
                                  asChild
                                  variant="outline"
                                  size="sm"
                                  className="border-[#18B2B0]/30 bg-[#18B2B0]/10 text-[#18B2B0] hover:bg-[#18B2B0]/15 font-bold text-xs"
                                >
                                  <Link href={`/technician-details/${technicianId}/item/${row.id}`}>
                                    <span className="me-1">{t("common.details_4")}</span>
                                    <ChevronLeft className="h-4 w-4" />
                                  </Link>
                                </Button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="bg-[#F8FAFB] px-6 py-4 border-t border-[#E6E8EC] flex items-center justify-between">
                  <p className="text-xs text-[#6B7280]">
                    {t("common.view")} {formatNumber(rows.length)} {t("common.item_1")}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-[#18B2B0]">
                    <Boxes className="h-3.5 w-3.5" />
                    {t("common.item_19128")}
                  </div>
                </div>
              </div>
            </TabsContent>
          );
        })}
      </Tabs>

      {/* Serial custody */}
      <section className="space-y-6">
        <div>
          <h3 className="text-xl font-black text-[#2D3135] tracking-tight flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-xl border border-cyan-400/25 bg-cyan-400/10">
              <Smartphone className="h-4 w-4 text-[#18B2B0]" />
            </span>
            {t("common.item_52592")}
          </h3>
          <p className="text-xs text-[#6B7280] mt-1.5 ms-11">{t("inventory.system_active_devices")}</p>
        </div>

        <Tabs value={activeSerialTab} onValueChange={(val) => setActiveSerialTab(val as "active" | "history")} className="w-full">
          <TabsList className="bg-transparent border-b border-[rgba(24,178,176,0.18)] mb-6 rounded-none p-0 h-auto gap-8 w-full justify-start">
            <TabsTrigger
              value="active"
              className="inline-flex items-center justify-center gap-2 pb-4 px-2 border-b-2 border-transparent data-[state=active]:border-[#18B2B0] data-[state=active]:text-[#18B2B0] text-[#6B7280] rounded-none leading-none"
            >
              <Handshake className="h-4 w-4 shrink-0" />
              {t("common.active_4")}
              <span className="rounded-md bg-[#18B2B0]/10 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-[#18B2B0]" dir="ltr">
                {formatNumber(serializedItems.length)}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="history"
              className="inline-flex items-center justify-center gap-2 pb-4 px-2 border-b-2 border-transparent data-[state=active]:border-[#18B2B0] data-[state=active]:text-[#18B2B0] text-[#6B7280] rounded-none leading-none"
            >
              <Truck className="h-4 w-4 shrink-0" />
              {t("common.log_1")}
              <span className="rounded-md bg-[#18B2B0]/10 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-[#18B2B0]" dir="ltr">
                {formatNumber(deliveryLogCount)}
              </span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="m-0">
            <div className="rounded-xl overflow-hidden border border-[rgba(24,178,176,0.18)] shadow-sm bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-start border-collapse">
                  <thead>
                    <tr className="bg-[#F3F4F6] border-b border-[#E6E8EC]">
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider">{t("common.name_7")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.number_serial_3")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.sim")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.status_4")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.category")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.date_receive")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E6E8EC]">
                    {serializedItems.length === 0 ? (
                      <tr>
                        <td className="px-6 py-14 text-center" colSpan={6}>
                          <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                            <div className="flex size-12 items-center justify-center rounded-2xl border border-[#18B2B0]/25 bg-[#18B2B0]/08 text-[#6B7280]">
                              <Boxes className="h-5 w-5" />
                            </div>
                            <p className="font-semibold text-[#4B5563]">{t("common.no_8")}</p>
                            <p className="text-xs text-[#6B7280]">{t("common.devices_log")}</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      serializedItems.map((item) => {
                        const statusLabel = t("common.item_27159");
                        const statusColor = "text-emerald-700 bg-emerald-50 border border-emerald-200";
                        let categoryLabel = t("common.devices_9");
                        if (item.itemTypeCategory === "sim") categoryLabel = t("common.sim_3");
                        else if (item.itemTypeCategory === "papers") categoryLabel = t("common.paper_1");
                        else if (item.itemTypeCategory === "accessories") categoryLabel = t("common.item_9545_1");

                        return (
                          <tr key={item.id} className="hover:bg-cyan-400/5 transition-colors group">
                            <td className="px-6 py-5">
                              <div className="flex items-center gap-3">
                                {renderProductImage(item.itemTypeCategory || "other", item.itemTypeName || "", "", item.carrierName)}
                                <div>
                                  <p className="text-sm font-bold text-[#2D3135] group-hover:text-[#18B2B0] transition-colors">
                                    {item.itemTypeName || t("common.item_17641")}
                                  </p>
                                  <p className="text-[10px] text-[#6B7280]">{item.itemTypeCategory || "Serialized Item"}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-5 text-center">
                              <span className="font-mono text-xs text-[#18B2B0] bg-cyan-400/5 px-2 py-1 rounded">{item.serialNumber}</span>
                            </td>
                            <td className="px-6 py-5 text-center font-mono text-xs text-[#4B5563]">
                              {item.itemTypeCategory === "sim" ? item.carrierName || t("common.sim_1") : item.barcode || "-"}
                            </td>
                            <td className="px-6 py-5 text-center">
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold ${statusColor}`}>
                                {statusLabel}
                              </span>
                            </td>
                            <td className="px-6 py-5 text-center text-xs text-[#4B5563]">{categoryLabel}</td>
                            <td className="px-6 py-5 text-center">
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold text-[#6B7280] bg-[#F3F4F6] border border-[#E2E8F0]">
                                {formatDateTime(item.createdAt)}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <div className="bg-[#F8FAFB] px-6 py-4 border-t border-[#E6E8EC]">
                <p className="text-xs text-[#6B7280]">
                  {t("common.view")} {formatNumber(serializedItems.length)} {t("common.item_1")}
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="history" className="m-0">
            <div className="rounded-xl overflow-hidden border border-[rgba(24,178,176,0.18)] shadow-sm bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-start border-collapse">
                  <thead>
                    <tr className="bg-[#F3F4F6] border-b border-[#E6E8EC]">
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider">{t("common.name_7")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.number_serial_3")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.number_device_1")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.status_4")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.type_warehouse")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.date_operations")}</th>
                      <th className="px-6 py-4 text-[#4B5563] font-bold text-xs uppercase tracking-wider text-center">{t("common.item_14214")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E6E8EC]">
                    {deliveryLogCount === 0 ? (
                      <tr>
                        <td className="px-6 py-14 text-center" colSpan={7}>
                          <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                            <div className="flex size-12 items-center justify-center rounded-2xl border border-[#18B2B0]/25 bg-[#18B2B0]/08 text-[#6B7280]">
                              <Truck className="h-5 w-5" />
                            </div>
                            <p className="font-semibold text-[#4B5563]">{t("common.no_9")}</p>
                            <p className="text-xs text-[#6B7280]">{t("common.requests_devices")}</p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <>
                        {deliveredItems.map((item) => {
                          let categoryLabel = t("common.devices_9");
                          if (item.itemTypeCategory === "sim") categoryLabel = t("common.sim_3");
                          else if (item.itemTypeCategory === "papers") categoryLabel = t("common.paper_1");
                          else if (item.itemTypeCategory === "accessories") categoryLabel = t("common.item_9545_1");

                          return (
                            <tr key={`v3-${item.movementId || item.id}`} className="hover:bg-cyan-400/5 transition-colors group">
                              <td className="px-6 py-5">
                                <div className="flex items-center gap-3">
                                  {renderProductImage(item.itemTypeCategory || "other", item.itemTypeName || "", "", item.carrierName)}
                                  <div>
                                    <p className="text-sm font-bold text-[#2D3135] group-hover:text-[#18B2B0] transition-colors">
                                      {item.itemTypeName || t("common.item_17641")}
                                    </p>
                                    <p className="text-[10px] text-[#6B7280]">
                                      {item.referenceId ? t("common.request_1", { var_0: item.referenceId }) : categoryLabel}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-6 py-5 text-center">
                                <span className="font-mono text-xs text-[#18B2B0] bg-cyan-400/5 px-2 py-1 rounded">{item.serialNumber}</span>
                              </td>
                              <td className="px-6 py-5 text-center font-mono text-xs text-[#4B5563]">
                                {item.itemTypeCategory === "sim" ? item.carrierName || "-" : item.barcode || "-"}
                              </td>
                              <td className="px-6 py-5 text-center">
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">
                                  {t("common.completed_2")}
                                </span>
                              </td>
                              <td className="px-6 py-5 text-center text-xs text-[#4B5563]">{t("common.item_16253")}</td>
                              <td className="px-6 py-5 text-center">
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold text-[#6B7280] bg-[#F3F4F6] border border-[#E2E8F0]">
                                  {formatDateTime(item.deliveredAt || item.createdAt)}
                                </span>
                              </td>
                              <td className="px-6 py-5 text-center">
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold text-[#4B5563] bg-[#F3F4F6] border border-[#E2E8F0]">
                                  {t("common.item_9632")}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                        {legacyDeliveredDevices
                          .filter((d) => !deliveredItems.some((i) => i.serialNumber === d.serialNumber))
                          .map((device) => {
                            const matchedType = itemTypes?.find((type) => type.id === device.itemTypeId);
                            const itemName =
                              matchedType?.nameAr ||
                              (device.terminalId ? t("common.device_3", { var_0: device.terminalId }) : t("common.device_1"));
                            return (
                              <tr
                                key={`legacy-${device.id}`}
                                onClick={() => {
                                  setSelectedDevice(device);
                                  setActiveStepIndex(3);
                                  setAdminNotesText("");
                                }}
                                className="hover:bg-cyan-400/5 transition-colors cursor-pointer group"
                              >
                                <td className="px-6 py-5">
                                  <div className="flex items-center gap-3">
                                    {renderProductImage(
                                      matchedType?.category || "other",
                                      matchedType?.nameAr || "",
                                      matchedType?.nameEn || "",
                                      device.simCardType
                                    )}
                                    <div>
                                      <p className="text-sm font-bold text-[#2D3135] group-hover:text-[#18B2B0] transition-colors">{itemName}</p>
                                      <p className="text-[10px] text-[#6B7280]">{matchedType?.nameEn || "Legacy"}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-6 py-5 text-center">
                                  <span className="font-mono text-xs text-[#18B2B0] bg-cyan-400/5 px-2 py-1 rounded">{device.serialNumber}</span>
                                </td>
                                <td className="px-6 py-5 text-center font-mono text-xs text-[#4B5563]">{device.terminalId || "-"}</td>
                                <td className="px-6 py-5 text-center">
                                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20">
                                    {t("common.completed_2")}
                                  </span>
                                </td>
                                <td className="px-6 py-5 text-center text-xs text-[#4B5563]">
                                  {device.inventoryType === "moving" ? t("common.item_24030") : t("common.item_14327")}
                                </td>
                                <td className="px-6 py-5 text-center">
                                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold text-[#6B7280] bg-[#F3F4F6] border border-[#E2E8F0]">
                                    {formatDateTime(device.updatedAt || device.createdAt)}
                                  </span>
                                </td>
                                <td className="px-6 py-5 text-center">
                                  <Button variant="ghost" size="sm" className="text-[#18B2B0] hover:text-[#18B2B0] hover:bg-cyan-400/10 text-xs font-bold">
                                    {t("common.view_details_2")}
                                  </Button>
                                </td>
                              </tr>
                            );
                          })}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="bg-[#F8FAFB] px-6 py-4 border-t border-[#E6E8EC]">
                <p className="text-xs text-[#6B7280]">
                  {t("common.view")} {formatNumber(deliveryLogCount)} {t("common.item_1")}
                </p>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </section>

      {/* Footer strips — item page style */}
      <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl p-4 flex items-center justify-between border border-[rgba(24,178,176,0.18)] bg-white shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-cyan-400/10 text-[#18B2B0]">
              <RefreshCw className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs text-slate-400">{t("common.inventory_3")}</p>
              <p className="text-sm font-black text-[#2D3135] tabular-nums" dir="ltr">
                {formatNumber(Number(inventoryAccuracy.toFixed(1)))}%
                <span className="ms-2 text-[10px] font-bold text-emerald-400">
                  {inventoryAccuracy >= 85
                    ? t("common.item_7959")
                    : inventoryAccuracy >= 60
                      ? t("common.item_6350")
                      : t("common.item_9546")}
                </span>
              </p>
            </div>
          </div>
        </div>
        <div className="rounded-xl p-4 flex items-center justify-between border border-orange-200 bg-white shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded bg-orange-500/10 text-orange-400">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs text-slate-400">{t("common.inventory_4")}</p>
              <p className="text-sm font-black text-amber-300 tabular-nums" dir="ltr">
                {formatNumber(lowStockAlertsCount)}
                {t("common.item_7942")}
              </p>
            </div>
          </div>
          <button type="button" className="text-[10px] font-bold text-[#18B2B0] underline underline-offset-4">
            {t("common.review")}
          </button>
        </div>
      </div>

      {/* Dialog modal for Scanned Device Details */}
      <Dialog open={!!selectedDevice} onOpenChange={(open) => !open && setSelectedDevice(null)}>
        <DialogContent className="sm:max-w-2xl bg-white border border-[rgba(24,178,176,0.22)] text-[#2D3135] p-6 rounded-2xl max-h-[90vh] overflow-y-auto shadow-xl" dir={dir}>
          <DialogHeader className="text-right border-b border-[#E6E8EC] pb-4 mb-4">
            <div className="flex items-start gap-3 mb-1">
              {selectedDevice ? (
                <div className="shrink-0">
                  {renderProductImage(
                    itemTypes?.find((it) => it.id === selectedDevice.itemTypeId)?.category || "devices",
                    itemTypes?.find((it) => it.id === selectedDevice.itemTypeId)?.nameAr || "",
                    itemTypes?.find((it) => it.id === selectedDevice.itemTypeId)?.nameEn || "",
                    selectedDevice.simCardType
                  )}
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-xl font-bold flex items-center gap-2 text-[#2D3135]">
                  <Smartphone className="w-5 h-5 text-[#18B2B0]" />
                  {t('inventory.details_device_sim')}
                </DialogTitle>
                <DialogDescription className="text-[#6B7280] text-xs mt-1">
                  {t('common.track_details')}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {selectedDevice && (
            <div className="space-y-6">
              {/* Stepper/Timeline */}
              <div className="bg-[#F8FAFB] p-4 rounded-xl border border-[#E6E8EC]">
                <div className="relative flex justify-between items-center">
                  {/* Progress Line */}
                  <div className="absolute top-[22px] left-[10%] right-[10%] h-[2px] bg-[#E2E8F0] -z-0">
                    <div 
                      className="h-full bg-emerald-500 transition-all duration-300"
                      style={{
                        width: selectedDevice.status === "delivered" 
                          ? "100%" 
                          : selectedDevice.status === "approved" 
                          ? "66%" 
                          : selectedDevice.status === "rejected"
                          ? "33%"
                          : "0%"
                      }}
                    />
                  </div>

                  {steps.map((step, idx) => {
                    const StepIcon = step.icon;
                    const isCompleted = isStepCompleted(idx, selectedDevice);
                    const isActive = activeStepIndex === idx;
                    
                    let stateColor = "text-[#9CA3AF] border-[#E2E8F0] bg-white";
                    if (isActive) {
                      stateColor = "text-[#18B2B0] border-[#18B2B0] bg-[#18B2B0]/10 shadow-md shadow-[#18B2B0]/15";
                    } else if (isCompleted) {
                      stateColor = "text-emerald-600 border-emerald-400 bg-emerald-50";
                    } else if (selectedDevice.status === "rejected" && idx === 1) {
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
                        <span className={`text-[11px] mt-1.5 font-bold ${isActive ? "text-[#18B2B0]" : isCompleted ? "text-emerald-600" : "text-[#6B7280]"}`}>
                          {step.title}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Detail Step Box */}
              <div className="bg-white p-5 rounded-xl border border-[#E6E8EC] shadow-sm">
                <div className="flex items-center gap-2 mb-4 border-b border-[#E6E8EC] pb-3">
                  {activeStepIndex === 0 && <Activity className="w-4 h-4 text-[#18B2B0]" />}
                  {activeStepIndex === 1 && <ShieldCheck className="w-4 h-4 text-[#18B2B0]" />}
                  {activeStepIndex === 2 && <Boxes className="w-4 h-4 text-[#18B2B0]" />}
                  {activeStepIndex === 3 && <Truck className="w-4 h-4 text-[#18B2B0]" />}
                  <h4 className="text-sm font-bold text-[#2D3135]">
                    {activeStepIndex === 0 && t('common.details_7')}
                    {activeStepIndex === 1 && t('common.supervisor_2')}
                    {activeStepIndex === 2 && t('common.status_10')}
                    {activeStepIndex === 3 && t('common.device_4')}
                  </h4>
                </div>

                <div className="divide-y divide-[#E6E8EC]">
                  {activeStepIndex === 0 && (
                    <>
                      {renderDetailItem(t('common.item_9548'), itemTypes?.find((t) => t.id === selectedDevice.itemTypeId)?.nameAr || t('common.device_1'))}
                      {renderDetailItem(t('common.number_serial_3'), selectedDevice.serialNumber, true)}
                      {renderDetailItem(t('common.number_device_2'), selectedDevice.terminalId || "-", true)}
                      {renderDetailItem(t('common.date_scan'), formatDateTime(selectedDevice.createdAt))}
                      {renderDetailItem(t('common.type_warehouse'), selectedDevice.inventoryType === "moving" ? t('common.item_24030') : t('common.item_14327'))}
                    </>
                  )}

                  {activeStepIndex === 1 && (
                    <>
                      {renderDetailItem(t('common.status_5'), 
                        selectedDevice.status === "approved" ? t('common.approved') : 
                        selectedDevice.status === "rejected" ? t('common.rejected') : t('common.pending_review')
                      )}
                      {renderDetailItem(t('common.supervisor_admin'), selectedDevice.approvedBy || t('common.review_1'))}
                      {renderDetailItem(t('common.date_3'), formatDateTime(selectedDevice.approvedAt))}
                      {renderDetailItem(t('common.notes_review'), selectedDevice.adminNotes || t('common.no_10'))}
                    </>
                  )}

                  {activeStepIndex === 2 && (
                    <>
                      {renderDetailItem(t('common.item_25468'), technicianName)}
                      {renderDetailItem(t('common.status_6'), 
                        (selectedDevice.status === "approved" || selectedDevice.status === "delivered")
                          ? t('common.technician_5') 
                          : t('common.item_35103')
                      )}
                      {renderDetailItem(t('common.type_3'), selectedDevice.inventoryType === "moving" ? t('common.technician_6') : t('common.warehouse_primary'))}
                      {renderDetailItem(t('common.signed_3'), t('common.item_46213'))}
                    </>
                  )}

                  {activeStepIndex === 3 && (
                    <>
                      {renderDetailItem(t('common.status_7'), t('common.completed_successfully_1'))}
                      {renderDetailItem(t('common.name_customer'), t('common.log_2'))}
                      {renderDetailItem(t('common.date_4'), formatDateTime(selectedDevice.updatedAt || selectedDevice.createdAt))}
                      {renderDetailItem(t('common.code_verification'), "OTP-4820", true)}
                      {renderDetailItem(t('common.received_admin'), t('common.manager_branch'))}
                      
                      {/* Customer Signature display */}
                      <div className="py-3 border-b border-[#E6E8EC]">
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
                            <span className="font-mono text-white/80">TID: {selectedDevice.terminalId || "N/A"}</span>
                          </div>
                        </div>
                      </div>

                      {/* GPS verification map */}
                      <div className="py-3 border-t border-[#E6E8EC] flex items-center justify-between">
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

              {/* Hardware Diagnostic Profile */}
              {(!selectedDevice.itemTypeId || itemTypes?.find((t) => t.id === selectedDevice.itemTypeId)?.category === "devices") && activeStepIndex < 3 && (
                <div className="space-y-3">
                  <h4 className="text-xs font-bold text-[#6B7280]">{t('common.technician_4')}</h4>
                  <div className="grid grid-cols-2 gap-3">
                    {renderAccessoryChip(t('common.battery_1'), !!selectedDevice.battery, Smartphone)}
                    {renderAccessoryChip(t('common.item_12740'), !!selectedDevice.chargerCable, Cable)}
                    {renderAccessoryChip(t('common.item_11125'), !!selectedDevice.chargerHead, Plug)}
                    {renderAccessoryChip(
                      selectedDevice.hasSim ? t('common.sim_2', { var_0: selectedDevice.simCardType || "SIM" }) : t('common.sim_3'),
                      !!selectedDevice.hasSim,
                      Smartphone
                    )}
                  </div>
                </div>
              )}

              {/* Damage Report Section */}
              {selectedDevice.damagePart && activeStepIndex < 3 && (
                <div className="p-4 rounded-xl bg-rose-500/5 border border-rose-500/20 flex gap-3 items-start">
                  <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="text-sm font-bold text-rose-700">{t('common.report')}</h5>
                    <p className="text-xs text-rose-400/90 mt-1">{selectedDevice.damagePart}</p>
                  </div>
                </div>
              )}

              {/* Inline Supervisor Decisions Form */}
              {selectedDevice.status === "pending" && (
                <div className="mt-6 pt-5 border-t border-[#E6E8EC]">
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
          )}

          <div className="mt-6 flex justify-end">
            <Button
              type="button"
              onClick={() => setSelectedDevice(null)}
              className="bg-[#F3F4F6] hover:bg-[#E5E7EB] text-[#2D3135] border border-[#E2E8F0] font-bold px-6"
            >
              {t('common.close')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
