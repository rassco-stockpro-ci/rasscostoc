import { useTranslation } from "@/lib/language";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2,
  AlertCircle,
  Search,
  Loader2,
  ArrowRight,
  Sparkles,
  Link2,
  Plus,
  RefreshCw,
  XCircle,
  Send,
  MessageSquare,
  ShieldAlert,
  User,
  MapPin,
  Calendar,
  Clock,
  FileText,
  Building2,
  CreditCard,
  Barcode,
  Trash2,
  Check,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { buildGoogleDrivePreviewUrl } from "./google-drive-preview";

type MatchStatus = "matched" | "needs_review" | "unknown";

export type SimCardItem = {
  sim_index: number;
  sim_serial: string;
  sim_type?: string;
  status?: "matched" | "not_found" | "unknown";
  lookupLoading?: boolean;
  lookupMessage?: string | null;
  technicianName?: string | null;
};

export type DeviceCard = {
  device_index: number;
  sn: string;
  sims: SimCardItem[];
  tid: string;
  merchant: string;
  confidence: number;
  match: {
    technician_name: string | null;
    technician_code: string | null;
    status: MatchStatus;
    confidence: number | null;
  };
  lookupLoading?: boolean;
  lookupMessage?: string | null;
};

export function formatTimeTo12Hour(timeStr: string | null | undefined): string | null {
  if (!timeStr) return null;
  const trimmed = timeStr.trim();
  if (!trimmed) return null;

  const ampmMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)$/i);
  if (ampmMatch) {
    const hh = parseInt(ampmMatch[1], 10);
    const mm = ampmMatch[2];
    const ss = ampmMatch[3] || "00";
    const period = ampmMatch[4].toUpperCase();
    return `${String(hh).padStart(2, "0")}:${mm}:${ss} ${period}`;
  }

  const match24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match24) return trimmed;

  let hour = parseInt(match24[1], 10);
  const minute = match24[2];
  const second = match24[3] || "00";
  const period = hour >= 12 ? "PM" : "AM";

  hour = hour % 12;
  if (hour === 0) hour = 12;

  return `${String(hour).padStart(2, "0")}:${minute}:${second} ${period}`;
}

type ExtractedPayload = {
  devices?: Array<{
    device_index?: number;
    sn?: string | null;
    sim_serial?: string | null;
    sims?: Array<SimCardItem | string>;
    tid?: string | null;
    merchant?: string | null;
    confidence?: number;
    match?: DeviceCard["match"];
  }>;
  date?: { value?: string | null; confidence?: number };
  time?: { value?: string | null; confidence?: number };
  transaction_date?: string | null;
  transaction_time?: string | null;
  approval_time?: string | null;
  transaction_datetime?: string | null;
  date_source?: "receipt" | "form" | "unknown" | null;
  date_confidence?: number | null;
  transaction_date_raw?: string | null;
  transaction_time_raw?: string | null;
  approval_time_raw?: string | null;
  transaction_date_confidence?: number | null;
  transaction_time_confidence?: number | null;
  approval_time_confidence?: number | null;
  sn?: { value?: string | null; confidence?: number };
  sim_serial?: { value?: string | null; confidence?: number };
  tid?: { value?: string | null; confidence?: number };
  retailer_name?: { value?: string | null; confidence?: number };
  extraction_source?: string;
};

interface PdfReportDetail {
  id: number;
  fileName: string;
  status: string;
  overallConfidence: number | null;
  requestId: number | null;
  uploadedBy?: string | null;
  technicianName?: string | null;
  technicianCode?: string | null;
  region?: string | null;
  createdAt?: string | null;
  extractedJson: ExtractedPayload;
  // بيانات الطلب المرتبط
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
  filePath?: string | null;
}

interface SearchResult {
  id: number;
  tid: string | null;
  terminalId: string | null;
  customerName: string | null;
}

interface SerialLookupResult {
  found: boolean;
  message?: string;
  technician?: {
    fullName: string;
    username: string;
    technicianCode: string | null;
  } | null;
}

function ConfidenceBadge({ value }: { value: number | null }) {
  if (value === null || value === undefined)
    return <span className="text-[#6B7280] text-xs">—</span>;
  const color =
    value >= 80
      ? "text-[#18B2B0] bg-[#18B2B0]/12 border-[#18B2B0]/25"
      : value >= 50
        ? "text-[#B45309] bg-[#F4B740]/18 border-[#F4B740]/35"
        : "text-[#E05252] bg-[#E05252]/12 border-[#E05252]/25";
  return (
    <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border ${color}`}>
      {value}%
    </span>
  );
}

function MatchBadge({ status }: { status: MatchStatus }) {
  if (status === "matched") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-[#18B2B0] bg-[#18B2B0]/12 border border-[#18B2B0]/25 px-2.5 py-1 rounded-full">
        <CheckCircle2 className="w-3.5 h-3.5" />
        مطابقة ناجحة
      </span>
    );
  }
  if (status === "needs_review") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-[#B45309] bg-[#F4B740]/18 border border-[#F4B740]/35 px-2.5 py-1 rounded-full">
        <AlertCircle className="w-3.5 h-3.5" />
        تحتاج مراجعة
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-[#6B7280] bg-[#F1F5F9] border border-[#E2E8F0] px-2.5 py-1 rounded-full">
      غير معروف
    </span>
  );
}

function StatusTag({ status }: { status: string }) {
  if (status === "applied") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-[#18B2B0] bg-[#18B2B0]/15 border border-[#18B2B0]/30 px-3 py-1 rounded-full">
        <CheckCircle2 className="w-4 h-4" />
        مُعتمد ومُطبَّق
      </span>
    );
  }
  if (status === "rejected") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-[#E05252] bg-[#E05252]/15 border border-[#E05252]/30 px-3 py-1 rounded-full">
        <XCircle className="w-4 h-4" />
        مرتجع / مراجعة الفني
      </span>
    );
  }
  if (status === "manual_review") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-[#B45309] bg-[#F4B740]/20 border border-[#F4B740]/40 px-3 py-1 rounded-full">
        <AlertCircle className="w-4 h-4" />
        بانتظار المراجعة الإدارية
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-[#6B7280] bg-[#F1F5F9] border border-[#E2E8F0] px-3 py-1 rounded-full">
      قيد المعالجة
    </span>
  );
}

function toCards(payload: ExtractedPayload | undefined): DeviceCard[] {
  const devices = payload?.devices;
  if (Array.isArray(devices) && devices.length > 0) {
    return devices
      .map((d: any, i) => {
        const rawSims = Array.isArray(d.sims) ? d.sims : null;
        let simList: SimCardItem[] = [];
        if (rawSims && rawSims.length > 0) {
          simList = rawSims.map((s: any, idx: number) => ({
            sim_index: idx + 1,
            sim_serial: typeof s === "string" ? s : s.sim_serial || s.serial || "",
            sim_type: s.sim_type || "STC",
            status: s.status || "unknown",
            technicianName: s.technicianName || null,
          }));
        } else if (d.sim_serial) {
          simList = [
            {
              sim_index: 1,
              sim_serial: d.sim_serial,
              sim_type: "STC",
              status: "unknown",
            },
          ];
        } else {
          simList = [
            {
              sim_index: 1,
              sim_serial: "",
              sim_type: "STC",
              status: "unknown",
            },
          ];
        }

        return {
          device_index: d.device_index ?? i + 1,
          sn: d.sn ?? "",
          sims: simList,
          tid: d.tid ?? "",
          merchant: d.merchant ?? "",
          confidence: d.confidence ?? 0,
          match: d.match ?? {
            technician_name: null,
            technician_code: null,
            status: "unknown" as MatchStatus,
            confidence: null,
          },
        };
      })
      .filter((d) => d.sn || d.sims.some(s => s.sim_serial) || d.tid || d.merchant);
  }

  const sn = payload?.sn?.value ?? "";
  const sim = payload?.sim_serial?.value ?? "";
  const tid = payload?.tid?.value ?? "";
  const merchant = payload?.retailer_name?.value ?? "";
  if (!sn && !sim && !tid && !merchant) return [];

  return [
    {
      device_index: 1,
      sn,
      sims: [{ sim_index: 1, sim_serial: sim, sim_type: "STC", status: "unknown" }],
      tid,
      merchant,
      confidence: payload?.sn?.confidence ?? 0,
      match: {
        technician_name: null,
        technician_code: null,
        status: "unknown",
        confidence: null,
      },
    },
  ];
}

export default function CourierPdfReviewPage() {
  const { t, dir } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [cards, setCards] = useState<DeviceCard[]>([]);
  const [deliveryDate, setDeliveryDate] = useState("");
  const [time, setTime] = useState("");
  
  // Receipt Date & Time State
  const [transactionDate, setTransactionDate] = useState("");
  const [transactionTime, setTransactionTime] = useState("");
  const [approvalTime, setApprovalTime] = useState("");
  const [transactionDateRaw, setTransactionDateRaw] = useState<string | null>(null);
  const [transactionTimeRaw, setTransactionTimeRaw] = useState<string | null>(null);
  const [approvalTimeRaw, setApprovalTimeRaw] = useState<string | null>(null);
  const [dateSource, setDateSource] = useState<string | null>(null);
  const [dateConfidence, setDateConfidence] = useState<number | null>(null);

  // Preview Iframe Controls
  const [previewKey, setPreviewKey] = useState(0);
  const [iframeError, setIframeError] = useState(false);

  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<SearchResult[]>([]);
  const [linkedRequestId, setLinkedRequestId] = useState<number | null>(null);
  const [linkedRequestTid, setLinkedRequestTid] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Rejection Dialog State
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [rejectReasonCategory, setRejectReasonCategory] = useState("UNCLEAR_PHOTO");
  const [rejectNotes, setRejectNotes] = useState("");
  const [rejecting, setRejecting] = useState(false);

  // Delete (admin only): removes the report and queues the Drive file + bot hash cleanup,
  // so the technician can upload the same report again. An applied report cannot be deleted.
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Link SIM Modal State
  const [linkSimModalOpen, setLinkSimModalOpen] = useState(false);
  const [targetSimSerial, setTargetSimSerial] = useState("");
  const [targetSimType, setTargetSimType] = useState("STC");
  const [targetTechnicianCode, setTargetTechnicianCode] = useState("");
  const [targetDeviceIdx, setTargetDeviceIdx] = useState<number | null>(null);
  const [targetSimIdx, setTargetSimIdx] = useState<number | null>(null);
  const [linkingSim, setLinkingSim] = useState(false);
  const [linkSimNotes, setLinkSimNotes] = useState("");

  const { data: report, isLoading, error } = useQuery<PdfReportDetail>({
    queryKey: [`/api/courier/pdf/${id}`],
    queryFn: () =>
      apiRequest("GET", `/api/courier/pdf/${id}`).then((r) => r.json()),
  });

  const matchedCount = useMemo(
    () => cards.filter((c) => c.match.status === "matched").length,
    [cards],
  );

  const isApplied = report?.status === "applied";

  useEffect(() => {
    if (!report) return;
    setLinkedRequestId(report.requestId);
    setCards(toCards(report.extractedJson));

    const ext = (report.extractedJson || {}) as any;
    const txDate = ext.transaction_date || ext.date?.value || "";
    const txTime = ext.transaction_time || ext.time?.value || "";
    const appTime = ext.approval_time || "";

    setDeliveryDate(txDate);
    setTime(txTime);
    setTransactionDate(txDate);
    setTransactionTime(txTime);
    setApprovalTime(appTime);

    setTransactionDateRaw(ext.transaction_date_raw || null);
    setTransactionTimeRaw(ext.transaction_time_raw || null);
    setApprovalTimeRaw(ext.approval_time_raw || null);
    setDateSource(ext.date_source || (txDate ? "receipt" : null));
    setDateConfidence(typeof ext.date_confidence === "number" ? ext.date_confidence : (ext.date?.confidence ?? null));

    if (report.technicianCode) {
      setTargetTechnicianCode(report.technicianCode);
    }
  }, [report]);

  useEffect(() => {
    if (!linkQuery) {
      setLinkResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      try {
        const res = await apiRequest(
          "GET",
          `/api/courier/requests?q=${encodeURIComponent(linkQuery)}&pageSize=5`,
        );
        const data = await res.json();
        setLinkResults(data.rows || []);
      } catch (err) {
        console.error(err);
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [linkQuery]);

  useEffect(() => {
    if (linkedRequestId) {
      apiRequest("GET", `/api/courier/requests/${linkedRequestId}`)
        .then((res) => res.json())
        .then((data) => setLinkedRequestTid(data.tid || `ID: ${data.id}`))
        .catch(() => setLinkedRequestTid(`ID: ${linkedRequestId}`));
    } else {
      setLinkedRequestTid(null);
    }
  }, [linkedRequestId]);

  useEffect(() => {
    if (!report?.id) return;
    let objectUrl: string | null = null;
    let cancelled = false;

    const filePath = (report as any).filePath as string | undefined;
    if (filePath && /^https?:\/\//i.test(filePath)) {
      setPreviewError(null);
      const embedUrl = buildGoogleDrivePreviewUrl(filePath);
      if (embedUrl) {
        // Safe /preview link built — try to embed it.
        setIframeError(false);
        setPreviewUrl(embedUrl);
      } else {
        // Never embed an unrecognized/raw URL (could be a /view link Google
        // itself blocks via X-Frame-Options, or something unexpected). Go
        // straight to the "open in Google Drive" fallback instead — previewUrl
        // just needs to be truthy so that branch renders; the fallback link
        // itself reads report.filePath directly, not this value.
        setIframeError(true);
        setPreviewUrl(filePath);
      }
      return;
    }

    (async () => {
      setPreviewError(null);
      try {
        const token = localStorage.getItem("auth-token");
        const res = await fetch(`/api/courier/pdf/${report.id}?raw=1`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`preview ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      } catch (err: any) {
        if (!cancelled) setPreviewError(err?.message || "فشل تحميل المعاينة");
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [report?.id]);

  const updateCard = (index: number, patch: Partial<DeviceCard>) => {
    setCards((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    );
  };

  const updateSim = (deviceIndex: number, simIndex: number, patch: Partial<SimCardItem>) => {
    setCards((prev) =>
      prev.map((c, i) => {
        if (i !== deviceIndex) return c;
        const updatedSims = c.sims.map((s, si) => (si === simIndex ? { ...s, ...patch } : s));
        return { ...c, sims: updatedSims };
      })
    );
  };

  const addSimToDevice = (deviceIndex: number) => {
    setCards((prev) =>
      prev.map((c, i) => {
        if (i !== deviceIndex) return c;
        const newSim: SimCardItem = {
          sim_index: c.sims.length + 1,
          sim_serial: "",
          sim_type: "STC",
          status: "unknown",
        };
        return { ...c, sims: [...c.sims, newSim] };
      })
    );
  };

  const removeSimFromDevice = (deviceIndex: number, simIndex: number) => {
    setCards((prev) =>
      prev.map((c, i) => {
        if (i !== deviceIndex) return c;
        if (c.sims.length <= 1) return c;
        const filtered = c.sims.filter((_, si) => si !== simIndex).map((s, idx) => ({ ...s, sim_index: idx + 1 }));
        return { ...c, sims: filtered };
      })
    );
  };

  const lookupSerial = async (index: number) => {
    const card = cards[index];
    const sn = card?.sn?.trim();
    if (!sn) return;
    updateCard(index, { lookupLoading: true, lookupMessage: null });
    try {
      const res = await apiRequest("POST", "/api/courier/serial-lookup", { sn });
      const data: SerialLookupResult = await res.json();
      if (data.found && data.technician) {
        updateCard(index, {
          lookupLoading: false,
          lookupMessage: `الفني: ${data.technician.fullName} (${data.technician.username})`,
          match: {
            technician_name: data.technician.fullName,
            technician_code: data.technician.username,
            status: "matched",
            confidence: 100,
          },
        });
      } else {
        updateCard(index, {
          lookupLoading: false,
          lookupMessage: data.message || "الجهاز غير مخصص أو غير موجود في العهدة",
          match: {
            technician_name: null,
            technician_code: null,
            status: "needs_review",
            confidence: 0,
          },
        });
      }
    } catch (err: any) {
      updateCard(index, {
        lookupLoading: false,
        lookupMessage: "تعذر التحقق من المخزون",
      });
    }
  };

  const lookupSim = async (deviceIdx: number, simIdx: number) => {
    const card = cards[deviceIdx];
    const sim = card?.sims[simIdx];
    const simSerial = sim?.sim_serial?.trim();
    if (!simSerial) return;

    updateSim(deviceIdx, simIdx, { lookupLoading: true, lookupMessage: null });
    try {
      const res = await apiRequest("POST", "/api/courier/serial-lookup", { sn: simSerial });
      const data: SerialLookupResult = await res.json();
      if (data.found) {
        updateSim(deviceIdx, simIdx, {
          lookupLoading: false,
          status: "matched",
          lookupMessage: data.message || `الشريحة موجودة بالأنظمة: ${data.technician?.fullName || ""}`,
          technicianName: data.technician?.fullName || null,
        });
      } else {
        updateSim(deviceIdx, simIdx, {
          lookupLoading: false,
          status: "not_found",
          lookupMessage: "الشريحة غير موجودة في النظام - اضغط زر إضافة وربط لتخصيصها للفني",
          technicianName: null,
        });
      }
    } catch (err: any) {
      updateSim(deviceIdx, simIdx, {
        lookupLoading: false,
        status: "unknown",
        lookupMessage: "تعذر التحقق من الشريحة حالياً",
      });
    }
  };

  const openLinkSimModal = (deviceIdx: number, simIdx: number) => {
    const card = cards[deviceIdx];
    const sim = card?.sims[simIdx];
    setTargetDeviceIdx(deviceIdx);
    setTargetSimIdx(simIdx);
    setTargetSimSerial(sim?.sim_serial || "");
    setTargetSimType(sim?.sim_type || "STC");
    setTargetTechnicianCode(report?.technicianCode || "");
    setLinkSimNotes(`تم الربط والتخصيص التلقائي من تقرير تركيب PDF #${id}`);
    setLinkSimModalOpen(true);
  };

  const handleLinkSimSubmit = async () => {
    if (!targetSimSerial.trim()) {
      toast({ title: "تنبيه", description: "يرجى كتابة رقم الشريحة الصحيح", variant: "destructive" });
      return;
    }
    setLinkingSim(true);
    try {
      const res = await apiRequest("POST", "/api/courier/sim-link", {
        simSerial: targetSimSerial.trim(),
        simType: targetSimType,
        technicianUsername: targetTechnicianCode,
        notes: linkSimNotes,
      });
      const data = await res.json();

      if (data.success) {
        toast({
          title: "تم ربط الشريحة بنجاح! ✅",
          description: `تم إدراج الشريحة ${targetSimSerial} وتخصيصها للفني ${report?.technicianName || targetTechnicianCode}`,
        });

        if (targetDeviceIdx !== null && targetSimIdx !== null) {
          updateSim(targetDeviceIdx, targetSimIdx, {
            sim_serial: targetSimSerial.trim(),
            sim_type: targetSimType,
            status: "matched",
            lookupMessage: "تم إدراج الشريحة وربطها بمخزون الفني بنجاح ✅",
            technicianName: report?.technicianName || targetTechnicianCode,
          });
        }

        setLinkSimModalOpen(false);
      } else {
        toast({ title: "خطأ في الربط", description: data.message || "تعذر ربط الشريحة", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "خطأ في العملية", description: err.message || "حدث خطأ أثناء الاتصال بالخادم", variant: "destructive" });
    } finally {
      setLinkingSim(false);
    }
  };

  const addDeviceCard = () => {
    setCards((prev) => [
      ...prev,
      {
        device_index: prev.length + 1,
        sn: "",
        sims: [{ sim_index: 1, sim_serial: "", sim_type: "STC", status: "unknown" }],
        tid: "",
        merchant: "",
        confidence: 100,
        match: {
          technician_name: null,
          technician_code: null,
          status: "unknown",
          confidence: null,
        },
      },
    ]);
  };

  const removeDeviceCard = (index: number) => {
    setCards((prev) => prev.filter((_, i) => i !== index));
  };

  const handleComplete = async () => {
    if (!report || !linkedRequestId) return;
    setCompleting(true);
    try {
      const body = {
        request_id: linkedRequestId,
        devices: cards.map((c, i) => ({
          device_index: i + 1,
          sn: c.sn.trim(),
          sim_serial: c.sims.map(s => s.sim_serial.trim()).filter(Boolean).join(", "),
          sims: c.sims.map(s => ({
            sim_index: s.sim_index,
            sim_serial: s.sim_serial.trim(),
            sim_type: s.sim_type || "STC",
            status: s.status || "unknown"
          })),
          tid: c.tid.trim(),
          merchant: c.merchant.trim(),
          confidence: c.confidence,
          match: c.match,
        })),
        deliveryDate: deliveryDate || null,
        time: time || null,
        paperRoll: "Yes",
      };

      await apiRequest("POST", `/api/courier/pdf/${report.id}/complete`, body);
      toast({
        title: "تم الاعتماد بنجاح! 🎉",
        description: "تم تحديث حالة التقرير والطلب وتحديث عهدة الفني بنجاح.",
      });
      queryClient.invalidateQueries({ queryKey: [`/api/courier/pdf/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/courier/pdf-reports"] });
    } catch (err: any) {
      toast({
        title: "خطأ أثناء الاعتماد",
        description: err.message || "تعذر إكمال الاعتماد، يرجى المحاولة لاحقاً.",
        variant: "destructive",
      });
    } finally {
      setCompleting(false);
    }
  };

  const handleReextract = async () => {
    if (!report) return;
    setReextracting(true);
    try {
      await apiRequest("POST", `/api/courier/pdf/${report.id}/reextract`);
      toast({
        title: "تمت إعادة الاستخراج",
        description: "تم تحديث البيانات المستخرجة باستخدام الذكاء الاصطناعي.",
      });
      queryClient.invalidateQueries({ queryKey: [`/api/courier/pdf/${id}`] });
    } catch (err: any) {
      toast({
        title: "خطأ في الاستخراج",
        description: err.message || "تعذر إعادة الاستخراج",
        variant: "destructive",
      });
    } finally {
      setReextracting(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!report) return;
    setDeleting(true);
    try {
      await apiRequest("DELETE", `/api/courier/pdf/${report.id}`);
      toast({
        title: "تم حذف التقرير 🗑️",
        description: "سيُحذف الملف الأصلي من Google Drive وتُحرَّر بصماته في البوت خلال دقيقة، ثم يمكن للفني رفعه من جديد.",
      });
      setDeleteModalOpen(false);
      queryClient.removeQueries({ queryKey: [`/api/courier/pdf/${id}`] });
      queryClient.invalidateQueries({
        predicate: (q) => String(q.queryKey[0] ?? "").startsWith("/api/courier/pdf"),
      });
      navigate("/courier/pdf");
    } catch (err: any) {
      toast({
        title: "تعذر حذف التقرير",
        description: err.message || "حدث خطأ أثناء الحذف، يرجى المحاولة لاحقاً.",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleRejectSubmit = async () => {
    if (!report) return;
    setRejecting(true);
    try {
      await apiRequest("POST", `/api/courier/pdf/${report.id}/reject`, {
        reasonCategory: rejectReasonCategory,
        notes: rejectNotes,
      });

      toast({
        title: "تم إرجاع التقرير للفني 📩",
        description: "تم تغيير حالة التقرير إلى مرتجع وإرسال التنبيه عبر التليجرام بنجاح.",
      });

      setRejectModalOpen(false);
      queryClient.invalidateQueries({ queryKey: [`/api/courier/pdf/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/courier/pdf-reports"] });
    } catch (err: any) {
      toast({
        title: "خطأ في عملية الإرجاع",
        description: err.message || "تعذر إرسال الإرجاع للفني",
        variant: "destructive",
      });
    } finally {
      setRejecting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-[#18B2B0]" />
        <p className="text-xs text-[#6B7280]">جاري تحميل بيانات تقرير التركيب…</p>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="bg-white p-6 rounded-2xl border border-red-100 text-center space-y-3">
        <AlertCircle className="w-10 h-10 text-[#E05252] mx-auto" />
        <h2 className="text-sm font-bold text-[#2D3135]">تعذر تحميل التقرير</h2>
        <p className="text-xs text-[#6B7280]">
          قد يكون التقرير غير موجود أو تم حذفه من النظام.
        </p>
        <button
          onClick={() => navigate("/courier/pdf")}
          className="px-4 py-2 text-xs font-bold text-[#18B2B0] bg-[#18B2B0]/10 hover:bg-[#18B2B0]/20 rounded-xl"
        >
          العودة لقائمة التقارير
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-sans text-right pb-12" dir={dir}>
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white/80 backdrop-blur-md p-5 rounded-2xl border border-[rgba(24,178,176,0.18)] shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/courier/pdf")}
            className="p-2 text-[#6B7280] hover:text-[#2D3135] hover:bg-[#F1F5F9] rounded-xl transition-colors"
            title="العودة"
          >
            <ArrowRight className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-[#2D3135]">
                مراجعة وتدقيق تقرير التركيب #{report.id}
              </h1>
              <StatusTag status={report.status} />
            </div>
            <p className="text-xs text-[#6B7280] mt-0.5 font-mono">
              {report.fileName} • {report.createdAt ? new Date(report.createdAt).toLocaleString("ar-SA") : ""}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleReextract}
            disabled={reextracting || isApplied}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-[#18B2B0] bg-[#18B2B0]/10 hover:bg-[#18B2B0]/20 rounded-xl transition-colors disabled:opacity-50"
          >
            {reextracting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            إعادة الاستخراج بالذكاء الاصطناعي
          </button>

          {!isApplied && (
            <button
              onClick={() => setRejectModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-[#E05252] bg-[#E05252]/10 hover:bg-[#E05252]/20 rounded-xl transition-colors border border-[#E05252]/20"
            >
              <XCircle className="w-4 h-4" />
              إرجاع للفني وإرسال إشعار
            </button>
          )}

          {isAdmin && !isApplied && (
            <button
              onClick={() => setDeleteModalOpen(true)}
              data-testid="button-delete-pdf-report"
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-white bg-[#E05252] hover:bg-[#C93F3F] rounded-xl transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              حذف التقرير
            </button>
          )}
        </div>
      </div>

      {/* Technician & Source Metadata Glass Panel */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white/80 backdrop-blur-md p-4 rounded-2xl border border-[rgba(24,178,176,0.16)] flex items-center gap-3">
          <div className="p-3 bg-[#18B2B0]/10 text-[#18B2B0] rounded-xl">
            <User className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-medium text-[#6B7280]">الفني المسؤول</span>
            <p className="text-xs font-bold text-[#2D3135] mt-0.5">
              {report.technicianName || "فني ميداني (تليجرام)"}
            </p>
            {report.technicianCode && (
              <span className="text-[10px] text-[#18B2B0] font-mono">@{report.technicianCode}</span>
            )}
          </div>
        </div>

        <div className="bg-white/80 backdrop-blur-md p-4 rounded-2xl border border-[rgba(24,178,176,0.16)] flex items-center gap-3">
          <div className="p-3 bg-[#18B2B0]/10 text-[#18B2B0] rounded-xl">
            <MapPin className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-medium text-[#6B7280]">المنطقة / المدينة</span>
            <p className="text-xs font-bold text-[#2D3135] mt-0.5">
              {report.region || "الرياض - الوسطى"}
            </p>
          </div>
        </div>

        <div className="bg-white/80 backdrop-blur-md p-4 rounded-2xl border border-[rgba(24,178,176,0.16)] flex items-center gap-3">
          <div className="p-3 bg-[#18B2B0]/10 text-[#18B2B0] rounded-xl">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-medium text-[#6B7280]">نسبة دقة الاستخراج</span>
            <div className="mt-0.5">
              <ConfidenceBadge value={report.overallConfidence} />
            </div>
          </div>
        </div>

        <div className="bg-white/80 backdrop-blur-md p-4 rounded-2xl border border-[rgba(24,178,176,0.16)] flex items-center gap-3">
          <div className="p-3 bg-[#18B2B0]/10 text-[#18B2B0] rounded-xl">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-medium text-[#6B7280]">حالة مطابقة الأجهزة</span>
            <p className="text-xs font-bold text-[#2D3135] mt-0.5">
              {matchedCount} من أصل {cards.length} جهاز مطابق
            </p>
          </div>
        </div>
      </div>

      {/* Customer / Request Data Panel — shows when a request is linked */}
      {report.requestId && (
        <div className="bg-white/80 backdrop-blur-md rounded-2xl border border-[rgba(24,178,176,0.18)] shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 bg-gradient-to-l from-[#18B2B0]/5 to-transparent px-5 py-3 border-b border-[#F1F5F9]">
            <div className="p-2 bg-[#18B2B0]/10 text-[#18B2B0] rounded-xl">
              <Building2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-bold text-[#2D3135]">بيانات الطلب والعميل</h2>
              <p className="text-[10px] text-[#6B7280]">طلب رقم #{report.requestId} — مستخرجة من قاعدة بيانات نيوليب</p>
            </div>
            <a
              href={`/courier/${report.requestId}`}
              target="_blank"
              rel="noreferrer"
              className="mr-auto text-[11px] font-bold text-[#18B2B0] hover:underline flex items-center gap-1 bg-[#18B2B0]/10 px-2.5 py-1 rounded-lg"
            >
              <Link2 className="w-3.5 h-3.5" />
              فتح الطلب
            </a>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-0 divide-x divide-x-reverse divide-[#F1F5F9]">
            {/* العميل / المتجر */}
            <div className="p-4 space-y-0.5">
              <span className="text-[10px] font-medium text-[#6B7280] block">اسم المتجر / العميل</span>
              <p className="text-xs font-bold text-[#2D3135] truncate" title={report.requestRetailerName || report.requestCustomerName || "-"}>
                {report.requestRetailerName || report.requestCustomerName || <span className="text-[#9CA3AF]">—</span>}
              </p>
              {report.requestRetailerName && report.requestCustomerName && (
                <p className="text-[10px] text-[#6B7280] truncate">{report.requestCustomerName}</p>
              )}
            </div>

            {/* المدينة */}
            <div className="p-4 space-y-0.5">
              <span className="text-[10px] font-medium text-[#6B7280] block">المدينة</span>
              <p className="text-xs font-bold text-[#2D3135]">
                {report.requestCity || <span className="text-[#9CA3AF]">—</span>}
              </p>
              {report.requestAddressAr && (
                <p className="text-[10px] text-[#6B7280] truncate" title={report.requestAddressAr}>{report.requestAddressAr}</p>
              )}
            </div>

            {/* TID */}
            <div className="p-4 space-y-0.5">
              <span className="text-[10px] font-medium text-[#6B7280] block">TID</span>
              <p className="text-xs font-bold font-mono text-[#18B2B0] truncate">
                {report.requestTid || <span className="text-[#9CA3AF]">—</span>}
              </p>
            </div>

            {/* Terminal */}
            <div className="p-4 space-y-0.5">
              <span className="text-[10px] font-medium text-[#6B7280] block">Terminal ID</span>
              <p className="text-xs font-bold font-mono text-[#2D3135] truncate">
                {report.requestTerminalId || <span className="text-[#9CA3AF]">—</span>}
              </p>
            </div>

            {/* الجوال */}
            <div className="p-4 space-y-0.5">
              <span className="text-[10px] font-medium text-[#6B7280] block">رقم الجوال</span>
              <p className="text-xs font-bold text-[#2D3135]">
                {report.requestMobile || <span className="text-[#9CA3AF]">—</span>}
              </p>
              {report.requestMobile2 && (
                <p className="text-[10px] text-[#6B7280]">{report.requestMobile2}</p>
              )}
            </div>

            {/* نوع التركيب */}
            <div className="p-4 space-y-0.5">
              <span className="text-[10px] font-medium text-[#6B7280] block">نوع التركيب</span>
              <p className="text-xs font-bold text-[#2D3135]">
                {report.requestInstallationType || <span className="text-[#9CA3AF]">—</span>}
              </p>
              {report.requestVendorType && (
                <p className="text-[10px] text-[#6B7280]">{report.requestVendorType}</p>
              )}
            </div>

            {/* تعيين الطلب / الفني */}
            <div className="p-4 space-y-0.5">
              <span className="text-[10px] font-medium text-[#6B7280] block">تعيين الطلب (فني)</span>
              <p className="text-xs font-bold text-[#2D3135]">
                {report.requestTecName || <span className="text-[#9CA3AF]">—</span>}
              </p>
            </div>

            {/* تاريخ الطلب */}
            <div className="p-4 space-y-0.5">
              <span className="text-[10px] font-medium text-[#6B7280] block">تاريخ الطلب</span>
              <p className="text-xs font-bold text-[#2D3135] font-mono">
                {report.requestDate || <span className="text-[#9CA3AF]">—</span>}
              </p>
            </div>
          </div>
        </div>
      )}


      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* PDF / Image Preview Column (5 cols) */}
        <div className="lg:col-span-5 space-y-3">
          <div className="bg-white/80 backdrop-blur-md p-4 rounded-2xl border border-[rgba(24,178,176,0.18)] shadow-sm sticky top-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold text-[#2D3135] flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-[#18B2B0]" />
                المستند الأصلي المرفوع
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setIframeError(false);
                    setPreviewKey((k) => k + 1);
                  }}
                  className="text-[11px] font-bold text-[#6B7280] hover:text-[#18B2B0] flex items-center gap-1 transition-colors bg-[#F1F5F9] px-2 py-1 rounded-lg"
                  title="إعادة تحميل المعاينة"
                >
                  <RefreshCw className="w-3 h-3" />
                  تحديث
                </button>
                <a
                  href={
                    /^https?:\/\//i.test((report as any).filePath || "")
                      ? (report as any).filePath
                      : `/api/courier/pdf/${report.id}?raw=1`
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] font-bold text-[#18B2B0] hover:underline flex items-center gap-1 bg-[#18B2B0]/10 px-2.5 py-1 rounded-lg"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  فتح في نافذة كاملة
                </a>
              </div>
            </div>

            <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl overflow-hidden min-h-[500px] flex items-center justify-center relative">
              {previewUrl ? (
                iframeError ? (
                  <div className="p-6 text-center space-y-3 bg-amber-50/50 border border-amber-200/60 rounded-xl m-4">
                    <ShieldAlert className="w-10 h-10 text-amber-600 mx-auto" />
                    <h4 className="text-xs font-bold text-amber-900">
                      تعذر عرض المستند داخل الصفحة بسبب صلاحيات Google Drive
                    </h4>
                    <p className="text-[11px] text-amber-700">
                      يمكنك مشاهدة المستند مباشرة في لسان جديد بالضغط على الزر أدناه
                    </p>
                    <a
                      href={(report as any)?.filePath || previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-[#18B2B0] text-white text-xs font-bold rounded-xl shadow hover:bg-[#159A98] transition-all"
                    >
                      <Link2 className="w-4 h-4" />
                      فتح المستند في Google Drive
                    </a>
                  </div>
                ) : /^https?:\/\//i.test((report as any).filePath || "") ||
                  report.fileName.toLowerCase().endsWith(".pdf") ? (
                  <iframe
                    key={previewKey}
                    src={previewUrl}
                    className="w-full h-[580px] border-none"
                    title="PDF Preview"
                    onError={() => setIframeError(true)}
                  />
                ) : (
                  <img
                    src={previewUrl}
                    alt="Document Proof"
                    className="max-h-[580px] w-full object-contain p-2"
                  />
                )
              ) : previewError ? (
                <div className="p-4 text-center">
                  <AlertCircle className="w-8 h-8 text-[#E05252] mx-auto mb-2" />
                  <p className="text-xs text-[#E05252]">{previewError}</p>
                </div>
              ) : (
                <Loader2 className="w-8 h-8 animate-spin text-[#18B2B0]" />
              )}
            </div>
          </div>
        </div>

        {/* Editable Cards Column (7 cols) */}
        <div className="lg:col-span-7 space-y-4">
          {/* Receipt Date & Time Section */}
          <div className="bg-white/90 backdrop-blur-md p-4 sm:p-5 rounded-2xl border border-[rgba(24,178,176,0.18)] shadow-sm space-y-3">
            <div className="flex items-center justify-between border-b border-[#F1F5F9] pb-3">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-[#18B2B0]/10 text-[#18B2B0] rounded-xl">
                  <Calendar className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-[#2D3135]">تاريخ ووقت العملية (مستخرج من الإيصال)</h3>
                  <p className="text-[11px] text-[#6B7280]">
                    بيانات توثيق وقت تنفيذ العملية وتاريخ الاعتماد المستخرجة من الإيصال
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {dateSource === "receipt" ? (
                  <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                    مستخرج من الإيصال
                  </span>
                ) : dateSource === "form" ? (
                  <span className="text-[11px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-2.5 py-0.5 rounded-full">
                    نموذج الخدمة
                  </span>
                ) : (
                  <span className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 text-amber-600" />
                    لم يتم استخراج تاريخ العملية
                  </span>
                )}
                <ConfidenceBadge value={dateConfidence} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Transaction Date */}
              <div>
                <label className="text-[11px] font-bold text-[#4B5563] mb-1 flex items-center gap-1">
                  <Calendar className="w-3.5 h-3.5 text-[#18B2B0]" />
                  تاريخ العملية (DD/MM/YYYY)
                </label>
                <input
                  type="text"
                  value={transactionDate}
                  onChange={(e) => setTransactionDate(e.target.value)}
                  disabled={isApplied}
                  placeholder="YYYY-MM-DD"
                  className="w-full text-xs font-mono px-3 py-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135] disabled:opacity-60"
                />
                {transactionDateRaw && (
                  <span className="text-[10px] text-[#6B7280] mt-0.5 block">
                    النص الخام: <code className="font-mono">{transactionDateRaw}</code>
                  </span>
                )}
              </div>

              {/* Transaction Time */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-bold text-[#4B5563] flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-[#18B2B0]" />
                    وقت العملية
                  </label>
                  {transactionTime && (
                    <span className="text-[10px] font-bold font-mono text-[#18B2B0] bg-[#18B2B0]/10 px-1.5 py-0.5 rounded">
                      {formatTimeTo12Hour(transactionTime)}
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  value={transactionTime}
                  onChange={(e) => setTransactionTime(e.target.value)}
                  disabled={isApplied}
                  placeholder="HH:mm:ss أو 05:55:42 PM"
                  className="w-full text-xs font-mono px-3 py-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135] disabled:opacity-60"
                />
                {transactionTimeRaw && (
                  <span className="text-[10px] text-[#6B7280] mt-0.5 block">
                    النص الخام: <code className="font-mono">{transactionTimeRaw}</code>
                  </span>
                )}
              </div>

              {/* Approval Time */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-bold text-[#4B5563] flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-[#18B2B0]" />
                    وقت الاعتماد / الموافقات
                  </label>
                  {approvalTime && (
                    <span className="text-[10px] font-bold font-mono text-[#18B2B0] bg-[#18B2B0]/10 px-1.5 py-0.5 rounded">
                      {formatTimeTo12Hour(approvalTime)}
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  value={approvalTime}
                  onChange={(e) => setApprovalTime(e.target.value)}
                  disabled={isApplied}
                  placeholder="HH:mm:ss أو 05:55:43 PM"
                  className="w-full text-xs font-mono px-3 py-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135] disabled:opacity-60"
                />
                {approvalTimeRaw && (
                  <span className="text-[10px] text-[#6B7280] mt-0.5 block">
                    النص الخام: <code className="font-mono">{approvalTimeRaw}</code>
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between bg-white/80 backdrop-blur-md p-4 rounded-2xl border border-[rgba(24,178,176,0.18)]">
            <div>
              <h2 className="text-sm font-bold text-[#2D3135]">
                بيانات الأجهزة والشرائح ({cards.length})
              </h2>
              <p className="text-[11px] text-[#6B7280]">
                يمكنك التعديل والتحقق من الأجهزة والشرائح مباشرة في الحقول أدناه.
              </p>
            </div>
            {!isApplied && (
              <button
                onClick={addDeviceCard}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-[#18B2B0] bg-[#18B2B0]/10 hover:bg-[#18B2B0]/20 rounded-xl transition-colors"
              >
                <Plus className="w-4 h-4" />
                إضافة جهاز جديد
              </button>
            )}
          </div>

          {/* Cards List */}
          <div className="space-y-4">
            {cards.map((card, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white/90 backdrop-blur-md p-4 sm:p-5 rounded-2xl border border-[rgba(24,178,176,0.18)] shadow-sm space-y-4 relative"
              >
                <div className="flex items-center justify-between border-b border-[#F1F5F9] pb-3">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-lg bg-[#18B2B0] text-white text-xs font-bold flex items-center justify-center font-mono">
                      #{card.device_index}
                    </span>
                    <h3 className="text-xs font-bold text-[#2D3135]">
                      بيانات الجهاز #{card.device_index}
                    </h3>
                    <ConfidenceBadge value={card.confidence} />
                  </div>
                  <div className="flex items-center gap-2">
                    <MatchBadge status={card.match.status} />
                    {!isApplied && cards.length > 1 && (
                      <button
                        onClick={() => removeDeviceCard(idx)}
                        className="text-[#E05252] hover:bg-red-50 p-1 rounded-lg transition-colors"
                        title="حذف الجهاز"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* S/N Input */}
                  <div>
                    <label className="text-[11px] font-bold text-[#4B5563] mb-1 flex items-center gap-1">
                      <Barcode className="w-3.5 h-3.5 text-[#18B2B0]" />
                      الرقم التسلسلي للجهاز (S/N)
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={card.sn}
                        onChange={(e) => updateCard(idx, { sn: e.target.value })}
                        disabled={isApplied}
                        placeholder="مثال: SAS30810005318"
                        className="w-full text-xs font-mono px-3 py-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135] disabled:opacity-60"
                      />
                      <button
                        onClick={() => lookupSerial(idx)}
                        disabled={card.lookupLoading || !card.sn.trim()}
                        className="px-2.5 py-1.5 text-xs font-bold text-[#18B2B0] bg-[#18B2B0]/10 hover:bg-[#18B2B0]/20 rounded-xl transition-colors shrink-0 disabled:opacity-50"
                        title="التحقق من العهدة"
                      >
                        {card.lookupLoading ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Search className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* TID Input */}
                  <div>
                    <label className="text-[11px] font-bold text-[#4B5563] mb-1 flex items-center gap-1">
                      <FileText className="w-3.5 h-3.5 text-[#18B2B0]" />
                      رقم العميل / Terminal ID (TID)
                    </label>
                    <input
                      type="text"
                      value={card.tid}
                      onChange={(e) => updateCard(idx, { tid: e.target.value })}
                      disabled={isApplied}
                      placeholder="مثال: 15112352"
                      className="w-full text-xs font-mono px-3 py-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135] disabled:opacity-60"
                    />
                  </div>

                  {/* Merchant Name Input */}
                  <div className="sm:col-span-2">
                    <label className="text-[11px] font-bold text-[#4B5563] mb-1 flex items-center gap-1">
                      <Building2 className="w-3.5 h-3.5 text-[#18B2B0]" />
                      اسم المتجر / العميل
                    </label>
                    <input
                      type="text"
                      value={card.merchant}
                      onChange={(e) => updateCard(idx, { merchant: e.target.value })}
                      disabled={isApplied}
                      placeholder="شركة يمر القطع"
                      className="w-full text-xs px-3 py-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135] disabled:opacity-60"
                    />
                  </div>
                </div>

                {card.lookupMessage && (
                  <p className="text-[11px] text-[#18B2B0] font-medium bg-[#18B2B0]/10 px-3 py-1.5 rounded-lg">
                    {card.lookupMessage}
                  </p>
                )}

                {/* Multi-SIM Section per Device */}
                <div className="border-t border-[#F1F5F9] pt-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[#2D3135] flex items-center gap-1.5">
                      <CreditCard className="w-4 h-4 text-[#18B2B0]" />
                      شرائح التوثيق لهذا الجهاز ({card.sims.length})
                    </span>
                    {!isApplied && (
                      <button
                        onClick={() => addSimToDevice(idx)}
                        className="text-[11px] font-bold text-[#18B2B0] hover:underline flex items-center gap-1"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        إضافة شريحة أخرى للجهاز
                      </button>
                    )}
                  </div>

                  <div className="space-y-3">
                    {card.sims.map((sim, sIdx) => (
                      <div
                        key={sIdx}
                        className="bg-[#F8FAFC] p-3 rounded-xl border border-[#E2E8F0] space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-[#4B5563]">
                            شريحة #{sim.sim_index} {sim.sim_type ? `(${sim.sim_type})` : ""}
                          </span>
                          {!isApplied && card.sims.length > 1 && (
                            <button
                              onClick={() => removeSimFromDevice(idx, sIdx)}
                              className="text-[#E05252] text-[10px] hover:underline"
                            >
                              حذف الشريحة
                            </button>
                          )}
                        </div>

                        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
                          <input
                            type="text"
                            value={sim.sim_serial}
                            onChange={(e) => updateSim(idx, sIdx, { sim_serial: e.target.value })}
                            disabled={isApplied}
                            placeholder="رقم الشريحة (SIM ICCID / Serial)..."
                            className="flex-1 text-xs font-mono px-3 py-2 bg-white border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135] disabled:opacity-60"
                          />

                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => lookupSim(idx, sIdx)}
                              disabled={sim.lookupLoading || !sim.sim_serial.trim()}
                              className="px-3 py-2 text-xs font-bold text-[#18B2B0] bg-[#18B2B0]/10 hover:bg-[#18B2B0]/20 rounded-xl transition-colors flex items-center gap-1 disabled:opacity-50 shrink-0"
                            >
                              {sim.lookupLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Search className="w-3.5 h-3.5" />
                              )}
                              التحقق في النظام
                            </button>

                            {sim.status === "not_found" && !isApplied && (
                              <button
                                onClick={() => openLinkSimModal(idx, sIdx)}
                                className="px-3 py-2 text-xs font-bold text-white bg-[#18B2B0] hover:bg-[#159A98] rounded-xl transition-all shadow-sm flex items-center gap-1.5 shrink-0"
                              >
                                <Link2 className="w-3.5 h-3.5" />
                                إضافة / ربط بالمخزون
                              </button>
                            )}

                            {sim.status === "matched" && (
                              <span className="text-[11px] font-bold text-[#18B2B0] bg-[#18B2B0]/12 px-2.5 py-1 rounded-lg flex items-center gap-1">
                                <Check className="w-3.5 h-3.5" />
                                موجودة بالنظام
                              </span>
                            )}
                          </div>
                        </div>

                        {sim.lookupMessage && (
                          <p className={`text-[11px] px-2.5 py-1 rounded-lg font-medium ${
                            sim.status === "matched"
                              ? "bg-[#18B2B0]/10 text-[#18B2B0]"
                              : sim.status === "not_found"
                              ? "bg-amber-50 text-amber-800 border border-amber-200"
                              : "bg-gray-100 text-gray-700"
                          }`}>
                            {sim.lookupMessage}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          {/* Linking Request & Action Bar */}
          <div className="bg-white/90 backdrop-blur-md p-5 rounded-2xl border border-[rgba(24,178,176,0.18)] shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-[#2D3135] border-b border-[#F1F5F9] pb-2">
              ربط الطلب والتطبيق المباشر
            </h3>

            {linkedRequestId ? (
              <div className="flex items-center justify-between p-3 bg-[#18B2B0]/10 border border-[#18B2B0]/25 rounded-xl">
                <div>
                  <span className="text-[10px] text-[#6B7280]">مرتبط بالطلب:</span>
                  <p className="text-xs font-bold text-[#18B2B0]">
                    طلب #{linkedRequestId} {linkedRequestTid ? `(${linkedRequestTid})` : ""}
                  </p>
                </div>
                {!isApplied && (
                  <button
                    onClick={() => {
                      setLinkedRequestId(null);
                      setLinkedRequestTid(null);
                    }}
                    className="text-xs font-bold text-[#E05252] hover:underline"
                  >
                    تغيير الربط
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-medium text-[#6B7280]">
                  البحث عن رقم طلب للربط به:
                </label>
                <div className="relative">
                  <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6B7280]" />
                  <input
                    value={linkQuery}
                    onChange={(e) => setLinkQuery(e.target.value)}
                    placeholder="ابحث برقم الطلب، اسم المتجر، أو رقم الهاتف…"
                    className="w-full text-xs pr-9 pl-3 py-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0]"
                  />
                </div>

                {linkQuery && linkResults.length > 0 && (
                  <div className="bg-white border border-[#E2E8F0] rounded-xl shadow-lg divide-y divide-[#F1F5F9] max-h-48 overflow-y-auto">
                    {linkResults.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => {
                          setLinkedRequestId(r.id);
                          setLinkedRequestTid(r.tid || `ID: ${r.id}`);
                          setLinkQuery("");
                        }}
                        className="w-full text-start p-2.5 hover:bg-[#18B2B0]/10 flex flex-col gap-0.5 transition-colors"
                      >
                        <span className="text-xs font-bold text-[#2D3135]">
                          {r.customerName || "عميل"} (طلب #{r.id})
                        </span>
                        <span className="text-[10px] text-[#6B7280] font-mono">
                          TID: {r.tid} | Terminal: {r.terminalId}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Action Buttons */}
            {!isApplied && (
              <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                <button
                  onClick={handleComplete}
                  disabled={completing || !linkedRequestId}
                  className="w-full sm:flex-1 py-3 px-4 text-xs font-bold text-white bg-[#18B2B0] hover:bg-[#159A98] rounded-xl transition-all shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {completing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4" />
                  )}
                  إكمال جميع الأجهزة والاعتماد ✅
                </button>

                <button
                  onClick={() => setRejectModalOpen(true)}
                  className="w-full sm:w-auto py-3 px-4 text-xs font-bold text-[#E05252] bg-[#E05252]/10 hover:bg-[#E05252]/20 border border-[#E05252]/25 rounded-xl transition-colors flex items-center justify-center gap-2"
                >
                  <XCircle className="w-4 h-4" />
                  إرجاع للفني ⚠️
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Link SIM Modal */}
      <AnimatePresence>
        {linkSimModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-md rounded-2xl shadow-xl border border-[rgba(24,178,176,0.18)] p-6 space-y-4 relative font-sans text-right"
              dir="rtl"
            >
              <div className="flex items-center justify-between border-b border-[#F1F5F9] pb-3">
                <div className="flex items-center gap-2 text-[#18B2B0]">
                  <CreditCard className="w-5 h-5" />
                  <h3 className="text-sm font-bold text-[#2D3135]">
                    ربط وإضافة شريحة بمخزون الفني 📱
                  </h3>
                </div>
                <button
                  onClick={() => setLinkSimModalOpen(false)}
                  className="text-[#6B7280] hover:text-[#2D3135] p-1 rounded-lg"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>

              <p className="text-xs text-[#6B7280] leading-relaxed">
                ستتم إضافة هذه الشريحة إلى قاعدة البيانات وتخصيصها فوراً لعهدة ومخزون الفني المسند للتقرير.
              </p>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-bold text-[#4B5563] block mb-1">
                    رقم الشريحة (SIM ICCID / Serial):
                  </label>
                  <input
                    type="text"
                    value={targetSimSerial}
                    onChange={(e) => setTargetSimSerial(e.target.value)}
                    className="w-full text-xs font-mono px-3 py-2 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135]"
                    placeholder="899660123456789"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-[#4B5563] block mb-1">
                    نوع / مشغل الشريحة (Carrier):
                  </label>
                  <select
                    value={targetSimType}
                    onChange={(e) => setTargetSimType(e.target.value)}
                    className="w-full text-xs p-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135]"
                  >
                    <option value="STC">📶 STC - الاتصالات السعودية</option>
                    <option value="Mobily">📶 Mobily - موبايلي</option>
                    <option value="Zain">📶 Zain - زين</option>
                    <option value="STC 4G">🌐 STC 4G Data</option>
                    <option value="Mobily 4G">🌐 Mobily 4G Data</option>
                    <option value="M2M">📟 M2M / eSIM Enterprise</option>
                    <option value="Other">❓ أخرى</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-bold text-[#4B5563] block mb-1">
                    الفني المخصص (مخزون الفني):
                  </label>
                  <input
                    type="text"
                    value={report?.technicianName ? `${report.technicianName} (@${targetTechnicianCode})` : targetTechnicianCode}
                    disabled
                    className="w-full text-xs px-3 py-2 bg-[#F1F5F9] border border-[#E2E8F0] rounded-xl text-[#4B5563] font-bold"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-[#4B5563] block mb-1">
                    ملاحظات الإدراج:
                  </label>
                  <textarea
                    rows={2}
                    value={linkSimNotes}
                    onChange={(e) => setLinkSimNotes(e.target.value)}
                    className="w-full text-xs p-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#F1F5F9]">
                <button
                  onClick={() => setLinkSimModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-[#6B7280] bg-[#F1F5F9] hover:bg-[#E2E8F0] rounded-xl transition-colors"
                >
                  إلغاء
                </button>
                <button
                  onClick={handleLinkSimSubmit}
                  disabled={linkingSim || !targetSimSerial.trim()}
                  className="px-4 py-2 text-xs font-bold text-white bg-[#18B2B0] hover:bg-[#159A98] rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {linkingSim ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Link2 className="w-4 h-4" />
                  )}
                  تأكيد إضافة وربط الشريحة
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Delete Confirmation Modal (admin only) */}
      <AnimatePresence>
        {deleteModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-lg rounded-2xl shadow-xl border border-[#E05252]/25 p-6 space-y-4 relative font-sans"
            >
              <div className="flex items-center gap-2 text-[#E05252] border-b border-[#F1F5F9] pb-3">
                <Trash2 className="w-5 h-5" />
                <h3 className="text-sm font-bold text-[#2D3135]">حذف التقرير رقم {report?.id} نهائياً</h3>
              </div>
              <ul className="text-xs text-[#4B5563] leading-relaxed list-disc pr-5 space-y-1">
                <li>يُحذف التقرير من النظام فوراً ويُسجَّل الحذف في سجل التدقيق.</li>
                <li>يحذف البوت ملف PDF الأصلي من Google Drive ويحرّر بصماته وبصمات صفحاته.</li>
                <li>بعدها يستطيع الفني رفع نفس التقرير من جديد عبر البوت.</li>
                <li className="font-bold text-[#E05252]">لا يمكن التراجع عن هذا الإجراء.</li>
              </ul>
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#F1F5F9]">
                <button
                  onClick={() => setDeleteModalOpen(false)}
                  disabled={deleting}
                  className="px-4 py-2 text-xs font-bold text-[#6B7280] bg-[#F1F5F9] hover:bg-[#E2E8F0] rounded-xl transition-colors"
                >
                  إلغاء
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  disabled={deleting}
                  data-testid="button-confirm-delete-pdf-report"
                  className="px-4 py-2 text-xs font-bold text-white bg-[#E05252] hover:bg-[#C93F3F] rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  تأكيد الحذف
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Interactive Rejection Modal */}
      <AnimatePresence>
        {rejectModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-lg rounded-2xl shadow-xl border border-[rgba(24,178,176,0.18)] p-6 space-y-4 relative font-sans"
            >
              <div className="flex items-center justify-between border-b border-[#F1F5F9] pb-3">
                <div className="flex items-center gap-2 text-[#E05252]">
                  <ShieldAlert className="w-5 h-5" />
                  <h3 className="text-sm font-bold text-[#2D3135]">
                    إرجاع تقرير التركيب للمراجعة (تليجرام)
                  </h3>
                </div>
                <button
                  onClick={() => setRejectModalOpen(false)}
                  className="text-[#6B7280] hover:text-[#2D3135] p-1 rounded-lg"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>

              <p className="text-xs text-[#6B7280] leading-relaxed">
                سيؤدي هذا الإجراء إلى تحديث حالة التقرير إلى <strong className="text-[#E05252]">مرتجع</strong> وإرسال <strong>رد مباشر على رسالة تقرير التركيب الأصلي</strong> في تليجرام الفني، يتضمن سبب المشكلة وملاحظتك المباشرة.
              </p>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-bold text-[#4B5563] block mb-1">
                    السبب الرئيسي للإرجاع:
                  </label>
                  <select
                    value={rejectReasonCategory}
                    onChange={(e) => setRejectReasonCategory(e.target.value)}
                    className="w-full text-xs p-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135]"
                  >
                    <option value="UNCLEAR_PHOTO">📸 صورة المستند/الملصق غير واضحة</option>
                    <option value="SERIAL_MISMATCH">🔢 الرقم التسلسلي للجهاز غير مطابق للعهدة</option>
                    <option value="SIM_MISMATCH">💳 رقم الشريحة (SIM) غير مطابق</option>
                    <option value="MERCHANT_TID_MISMATCH">🏬 بيانات التاجر أو TID غير مطابقة</option>
                    <option value="OTHER">❓ سبب آخر (موضح بالملاحظات)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-bold text-[#4B5563] block mb-1">
                    📝 ملاحظة المشرف المباشرة للفني:
                  </label>
                  <textarea
                    rows={3}
                    value={rejectNotes}
                    onChange={(e) => setRejectNotes(e.target.value)}
                    placeholder="اكتب التوضيح المباشر للفني (مثال: الرقم التسلسلي الأخير مغطى، يرجى إعادة التصوير)..."
                    className="w-full text-xs p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl focus:outline-none focus:border-[#18B2B0] text-[#2D3135]"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#F1F5F9]">
                <button
                  onClick={() => setRejectModalOpen(false)}
                  className="px-4 py-2 text-xs font-bold text-[#6B7280] bg-[#F1F5F9] hover:bg-[#E2E8F0] rounded-xl transition-colors"
                >
                  إلغاء
                </button>
                <button
                  onClick={handleRejectSubmit}
                  disabled={rejecting}
                  className="px-4 py-2 text-xs font-bold text-white bg-[#E05252] hover:bg-[#C93F3F] rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  {rejecting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  إرسال الإشعار وإرجاع التقرير
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
