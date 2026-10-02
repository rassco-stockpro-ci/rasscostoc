import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SimTypeField } from "@/components/courier-sim-type-field";
import { deriveSimTypes } from "@/lib/sim-type";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Loader2,
  Save,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Search,
  BadgeCheck,
  XCircle,
  Lock,
  Plus,
  Trash2,
  Info,
} from "lucide-react";

interface Lookups {
  cities: { id: number; nameAr: string }[];
  simTypes: { id: number; name: string }[];
  vendorTypes: { id: number; name: string }[];
  failureReasons: { id: number; labelAr: string; code: string }[];
  technicians: { id: string; code: string; name: string }[];
}

interface Execution {
  installationStatus: string | null;
  salesTechnician: string | null;
  technicianCode: string | null;
  sn: string | null;
  simSerial: string | null;
  simType: string | null;
  deliveryDate: string | null;
  time: string | null;
  paperRoll: string | null;
  paperRollQty?: number | null;
  stickersQty?: number | null;
  nulipCardsQty?: number | null;
  responseReasonCode: string | null;
  customerNotes: string | null;
  requestPriorityLevel: string | null;
  pushBack: string | null;
  responseDate: string | null;
  version?: number;
}

interface RequestItem {
  id: number;
  itemType: string;
  serialNumber: string | null;
  simSerial: string | null;
  status: string;
}

interface RequestDetail {
  id: number;
  date: string | null;
  tid: string | null;
  terminalId: string | null;
  customerName: string | null;
  retailerName: string | null;
  city: string | null;
  cityTec: string | null;
  addressAr: string | null;
  mobile: string | null;
  mobile2: string | null;
  tecName: string | null;
  installationType: string | null;
  vendorType: string | null;
  sim: string | null;
  otp: string | null;
  ticketingHolouly: string | null;
  incidentNumber: string | null;
  pinCode: string | null;
  trsm: string | null;
  simSn: string | null;
  execution: Execution | null;
  items?: RequestItem[];
}

interface SerialLookupResult {
  found: boolean;
  /** Exact inventory match (absent for a partial-match fallback). */
  item?: { id: string; serialNumber: string; status: string } | null;
  normalized?: string;
  itemType?: { id: string; nameAr: string; category: string; carrierName: string | null } | null;
  technician?: { id: string; fullName: string; username: string; technicianCode: string | null } | null;
  custodyStatus?: string | null;
  inActiveCustody?: boolean;
  message?: string;
}

type SerialRow = {
  id: string;
  value: string;
  lookup: SerialLookupResult | null;
  loading: boolean;
};

function newRow(value = ""): SerialRow {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, value, lookup: null, loading: false };
}

function isCompletedStatus(status?: string | null) {
  return status === "Installation Completed" || status === "Installation Completed - NL";
}

function DetailRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 border-b border-[#E2E8F0]/20 pb-1 text-xs">
      <span className="text-slate-450 min-w-[120px]">{label}:</span>
      <span className="text-[#2D3135] font-medium">{value}</span>
    </div>
  );
}

function LookupBadge({ lookup }: { lookup: SerialLookupResult | null }) {
  if (!lookup) return null;
  const ok = lookup.found && lookup.inActiveCustody;
  return (
    <div
      className={`mt-1 flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-md ${
        ok ? "bg-[#18B2B0]/10 text-[#18B2B0]" : "bg-red-500/10 text-red-400"
      }`}
    >
      {ok ? <BadgeCheck className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {lookup.found
        ? `${lookup.itemType?.nameAr ?? "عنصر"} · ${lookup.custodyStatus ?? ""}${
            lookup.technician ? ` · ${lookup.technician.fullName}` : ""
          }${lookup.itemType?.carrierName ? ` · ${lookup.itemType.carrierName}` : ""}`
        : lookup.message ?? "الرقم غير موجود"}
    </div>
  );
}

export function EditCourierExecutionModal({
  open,
  onOpenChange,
  requestId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: number | null;
  onSuccess?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [phase, setPhase] = useState<1 | 2>(1);
  const [form, setForm] = useState<Partial<Execution>>({});
  const [deviceRows, setDeviceRows] = useState<SerialRow[]>([newRow()]);
  const [simRows, setSimRows] = useState<SerialRow[]>([newRow()]);
  const [loadedSerials, setLoadedSerials] = useState(false);

  const { data: lookups } = useQuery<Lookups>({
    queryKey: ["/api/courier/lookups"],
    queryFn: () => apiRequest("GET", "/api/courier/lookups").then((r) => r.json()),
    enabled: open,
  });

  const { data: request, isLoading: requestLoading } = useQuery<RequestDetail>({
    queryKey: ["/api/courier/requests/detail-modal", requestId],
    queryFn: () => apiRequest("GET", `/api/courier/requests/${requestId}`).then((r) => r.json()),
    enabled: open && requestId !== null,
  });

  const exec = request?.execution;
  const currentForm = { ...exec, ...form };
  const completing = isCompletedStatus(currentForm.installationStatus);
  const primaryDeviceLookup = deviceRows.find((r) => r.lookup?.technician)?.lookup ?? deviceRows[0]?.lookup ?? null;

  const doSerialLookup = useCallback(
    async (rowId: string, sn: string, role: "device" | "sim") => {
      if (!sn.trim()) return;
      const setRows = role === "device" ? setDeviceRows : setSimRows;
      setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, loading: true } : r)));
      try {
        const res = await apiRequest("POST", "/api/courier/serial-lookup", { sn: sn.trim() });
        const data: SerialLookupResult = await res.json();
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== rowId) return r;
            const nextValue =
              role === "sim" && data.normalized && data.normalized !== r.value.trim()
                ? data.normalized
                : r.value;
            return { ...r, value: nextValue, lookup: data, loading: false };
          })
        );
        if (role === "device" && data.found && data.technician) {
          setForm((prev) => ({
            ...prev,
            technicianCode: data.technician!.technicianCode ?? data.technician!.username,
            salesTechnician: data.technician!.fullName,
          }));
        }
        // SIM type is NOT written into the form: it is derived from the lookup for display
        // (SimTypeField) and re-derived from inventory by the backend on close.
      } catch {
        setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, loading: false } : r)));
        toast({ title: "تعذّر البحث", description: `فشل البحث عن الرقم: ${sn}`, variant: "destructive" });
      }
    },
    [toast]
  );

  useEffect(() => {
    if (open) {
      setPhase(1);
      setForm({});
      setDeviceRows([newRow()]);
      setSimRows([newRow()]);
      setLoadedSerials(false);
    }
  }, [open, requestId]);

  useEffect(() => {
    if (!open || !request || loadedSerials) return;
    setLoadedSerials(true);

    if (request.execution) {
      setForm({
        installationStatus: request.execution.installationStatus ?? undefined,
        salesTechnician: request.execution.salesTechnician || undefined,
        technicianCode: request.execution.technicianCode || undefined,
        sn: request.execution.sn || undefined,
        simSerial: request.execution.simSerial || undefined,
        simType: request.execution.simType || undefined,
        deliveryDate: request.execution.deliveryDate || undefined,
        time: request.execution.time || undefined,
        paperRoll: request.execution.paperRoll || undefined,
        paperRollQty: request.execution.paperRollQty ?? 0,
        stickersQty: request.execution.stickersQty ?? 0,
        nulipCardsQty: request.execution.nulipCardsQty ?? 0,
        responseReasonCode: request.execution.responseReasonCode || undefined,
        customerNotes: request.execution.customerNotes || undefined,
        requestPriorityLevel: request.execution.requestPriorityLevel || undefined,
        pushBack: request.execution.pushBack || undefined,
        responseDate: request.execution.responseDate || undefined,
        version: request.execution.version,
      });
    }

    if (
      request.execution?.salesTechnician &&
      request.tecName &&
      request.execution.salesTechnician === request.tecName
    ) {
      setForm((prev) => ({ ...prev, salesTechnician: undefined, technicianCode: undefined }));
    }

    const items = request.items ?? [];
    const deviceSerials = items
      .filter((i) => i.itemType === "POS" && i.serialNumber)
      .map((i) => i.serialNumber!)
      .filter(Boolean);
    const simSerials = items
      .filter((i) => i.itemType === "SIM" && (i.simSerial || i.serialNumber))
      .map((i) => (i.simSerial || i.serialNumber)!)
      .filter(Boolean);

    if (request.execution?.sn && !deviceSerials.includes(request.execution.sn)) {
      deviceSerials.unshift(request.execution.sn);
    }
    if (!deviceSerials.length && request.execution?.sn) deviceSerials.push(request.execution.sn);

    const primarySim = request.execution?.simSerial || request.simSn;
    if (primarySim && !simSerials.includes(primarySim)) simSerials.unshift(primarySim);

    const nextDevices = (deviceSerials.length ? deviceSerials : [""]).map((v) => newRow(v));
    const nextSims = (simSerials.length ? simSerials : [""]).map((v) => newRow(v));
    setDeviceRows(nextDevices);
    setSimRows(nextSims);

    nextDevices.forEach((row) => {
      if (row.value.trim()) doSerialLookup(row.id, row.value.trim(), "device");
    });
    nextSims.forEach((row) => {
      if (row.value.trim()) doSerialLookup(row.id, row.value.trim(), "sim");
    });
  }, [request, open, loadedSerials, doSerialLookup]);

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("POST", `/api/courier/executions/${requestId}`, data).then((r) => r.json()),
    onSuccess: () => {
      toast({
        title: "تم الحفظ بنجاح",
        description: completing
          ? "تم إكمال الطلب وخصم الأجهزة/الشرائح من عهدة الفني."
          : "تم حفظ الطلب بدون خصم من العهدة (حالة غير مكتملة).",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/courier/requests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/courier/dashboard/stats"] });
      onOpenChange(false);
      if (onSuccess) onSuccess();
    },
    onError: (error: any) => {
      toast({
        title: "خطأ",
        description: error.message || "فشل حفظ البيانات، يرجى المحاولة مجدداً.",
        variant: "destructive",
      });
    },
  });

  const handleChange = (field: keyof Execution, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const updateRowValue = (role: "device" | "sim", rowId: string, value: string) => {
    const setRows = role === "device" ? setDeviceRows : setSimRows;
    setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, value, lookup: null } : r)));
    const minLen = role === "device" ? 9 : 18;
    if (value.trim().length >= minLen) doSerialLookup(rowId, value.trim(), role);
  };

  const handleNextPhase = () => {
    if (!currentForm.installationStatus) {
      toast({ title: "تنبيه", description: "يرجى تحديد حالة التركيب أولاً.", variant: "destructive" });
      return;
    }
    setPhase(2);
  };

  const handleSave = () => {
    if (!currentForm.installationStatus) {
      toast({ title: "تنبيه", description: "يرجى تحديد حالة التركيب أولاً.", variant: "destructive" });
      return;
    }

    if (completing) {
      const deviceSerials = deviceRows.map((r) => r.value.trim()).filter(Boolean);
      const simSerials = simRows.map((r) => r.value.trim()).filter(Boolean);
      if (deviceSerials.length === 0) {
        toast({ title: "تنبيه", description: "أدخل رقم جهاز واحد على الأقل قبل الإكمال.", variant: "destructive" });
        return;
      }
      const primary = deviceRows.find((r) => r.value.trim());
      if (!primary?.lookup?.found || !primary.lookup.technician) {
        toast({
          title: "لم يتم التعرف على الفني من العهدة",
          description: "أدخل رقم جهاز موجود في مخزون الفني ليظهر اسمه تلقائياً. لا يُعتمد اسم التعيين.",
          variant: "destructive",
        });
        return;
      }

      mutation.mutate({
        installationStatus: currentForm.installationStatus,
        paperRoll: currentForm.paperRoll,
        paperRollQty: Number(currentForm.paperRollQty) || 0,
        stickersQty: Number(currentForm.stickersQty) || 0,
        nulipCardsQty: Number(currentForm.nulipCardsQty) || 0,
        time: currentForm.time,
        deliveryDate: currentForm.deliveryDate,
        responseDate: currentForm.responseDate,
        sn: deviceSerials[0],
        simSerial: simSerials[0] || null,
        deviceSerials,
        simSerials,
        // Restated for the backend to verify against inventory; undefined when unknown.
        simType: deriveSimTypes(simRows).primary ?? undefined,
        customerNotes: currentForm.customerNotes,
        responseReasonCode: currentForm.responseReasonCode,
        version: currentForm.version,
        technicianCode:
          primary.lookup.technician.technicianCode ?? primary.lookup.technician.username,
        salesTechnician: primary.lookup.technician.fullName,
      });
      return;
    }

    if (currentForm.installationStatus === "Not Completed" && !currentForm.responseReasonCode) {
      toast({ title: "تنبيه", description: "اختر سبب الفشل قبل الحفظ.", variant: "destructive" });
      return;
    }

    // Incomplete: no serials required, no custody deduct
    mutation.mutate({
      installationStatus: currentForm.installationStatus,
      paperRoll: currentForm.paperRoll,
      paperRollQty: Number(currentForm.paperRollQty) || 0,
      stickersQty: Number(currentForm.stickersQty) || 0,
      nulipCardsQty: Number(currentForm.nulipCardsQty) || 0,
      time: currentForm.time,
      deliveryDate: currentForm.deliveryDate,
      responseDate: currentForm.responseDate,
      simType: currentForm.simType,
      customerNotes: currentForm.customerNotes,
      responseReasonCode: currentForm.responseReasonCode,
      version: currentForm.version,
    });
  };

  const statusBorder = completing
    ? "border-[#18B2B0]/40"
    : currentForm.installationStatus === "Not Completed"
      ? "border-red-500/40"
      : "border-[#E2E8F0]";

  const renderSerialList = (role: "device" | "sim") => {
    const rows = role === "device" ? deviceRows : simRows;
    const setRows = role === "device" ? setDeviceRows : setSimRows;
    const label = role === "device" ? "الرقم التسلسلي للجهاز (SN)" : "الرقم التسلسلي للشريحة (ICCID)";
    const placeholder = role === "device" ? "أدخل أو امسح الرقم التسلسلي..." : "89...";

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="block text-[10px] text-slate-450 font-medium">
            {label}
            {role === "device" ? " *" : ""}
          </label>
          <button
            type="button"
            onClick={() => setRows((prev) => [...prev, newRow()])}
            className="text-[10px] text-[#18B2B0] hover:text-[#18B2B0] flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            إضافة {role === "device" ? "جهاز" : "شريحة"}
          </button>
        </div>
        {rows.map((row, idx) => (
          <div key={row.id} className="space-y-1">
            <div className="flex gap-1.5">
              <input
                value={row.value}
                onChange={(e) => updateRowValue(role, row.id, e.target.value)}
                onBlur={(e) => {
                  if (e.target.value.trim()) doSerialLookup(row.id, e.target.value.trim(), role);
                }}
                placeholder={`${placeholder}${rows.length > 1 ? ` (${idx + 1})` : ""}`}
                className="flex-1 rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0] font-mono"
              />
              <button
                type="button"
                onClick={() => {
                  if (row.value.trim()) doSerialLookup(row.id, row.value.trim(), role);
                }}
                className="bg-[#18B2B0]/15 border border-[#18B2B0]/30 text-[#18B2B0] px-2 rounded-lg"
              >
                {row.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              </button>
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                  className="bg-red-900/30 border border-red-800/40 text-red-300 px-2 rounded-lg"
                  title="حذف"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <LookupBadge lookup={row.lookup} />
          </div>
        ))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto bg-white border-[1.5px] border-[rgba(24,178,176,0.28)] text-[#2D3135] p-0 rounded-2xl shadow-[0_20px_50px_rgba(24,178,176,0.12)]">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-[rgba(24,178,176,0.16)] bg-[#F8FAFC]/80">
          <DialogTitle className="text-base font-extrabold text-[#2D3135] flex items-center gap-2">
            بيانات التنفيذ الميداني
            {requestId && <span className="text-[#6B7280] font-mono text-xs">#{requestId}</span>}
          </DialogTitle>
          <DialogDescription className="text-xs text-[#6B7280]">
            الفني يُجلب تلقائياً من عهدة الجهاز — وليس من اسم التعيين. يمكن إضافة أكثر من جهاز وشريحة.
          </DialogDescription>
        </DialogHeader>

        {requestLoading ? (
          <div className="flex items-center justify-center py-16 text-[#6B7280] gap-2">
            <Loader2 className="animate-spin w-5 h-5" />
            <span className="text-sm">جاري التحميل...</span>
          </div>
        ) : !request ? (
          <div className="text-center py-16 text-[#6B7280] text-sm">الطلب غير موجود</div>
        ) : (
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rassco-glass border border-[#E2E8F0] rounded-xl p-3 space-y-1.5">
                <p className="text-[10px] font-bold text-[#6B7280] mb-2">بيانات الطلب</p>
                <DetailRow label="العميل" value={request.customerName} />
                <DetailRow label="المدينة" value={request.city} />
                <DetailRow label="تعيين الطلب" value={request.tecName} />
                <DetailRow label="TID" value={request.tid} />
                <DetailRow label="Terminal" value={request.terminalId} />
              </div>

              <div className="rassco-glass border border-[#E2E8F0] rounded-xl p-3">
                <div className="flex items-center gap-2 mb-3">
                  <div
                    className={`flex items-center gap-1.5 text-[10px] font-semibold ${
                      phase === 1 ? "text-[#18B2B0]" : "text-[#6B7280]"
                    }`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                        phase === 1 ? "bg-[#18B2B0] text-white" : "bg-[#4B5563] text-white"
                      }`}
                    >
                      1
                    </span>
                    التحقق
                  </div>
                  <div className="flex-1 h-px bg-[#4B5563]" />
                  <div
                    className={`flex items-center gap-1.5 text-[10px] font-semibold ${
                      phase === 2 ? "text-[#18B2B0]" : "text-[#6B7280]"
                    }`}
                  >
                    <span
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                        phase === 2 ? "bg-[#18B2B0] text-white" : "bg-[#4B5563] text-white"
                      }`}
                    >
                      2
                    </span>
                    التنفيذ
                  </div>
                </div>

                <div className="space-y-3">
                  {phase === 1 ? (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-[10px] text-slate-450 mb-1 font-medium">حالة التركيب *</label>
                        <select
                          value={currentForm.installationStatus || ""}
                          onChange={(e) => handleChange("installationStatus", e.target.value)}
                          className={`w-full bg-white border ${statusBorder} rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0]`}
                        >
                          <option value="">اختر الحالة</option>
                          <option value="Installation Completed">مكتمل</option>
                          <option value="Not Completed">غير مكتمل</option>
                          <option value="Customer Not Answering">العميل لا يرد</option>
                          <option value="In Progress">تحت الإجراء</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-450 mb-1 font-medium">
                          ملاحظات العميل / المشرف
                        </label>
                        <textarea
                          value={currentForm.customerNotes || ""}
                          onChange={(e) => handleChange("customerNotes", e.target.value)}
                          rows={3}
                          className="w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0] resize-none"
                          placeholder="ملاحظات التركيب..."
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {completing ? (
                        <>
                          {renderSerialList("device")}
                          {renderSerialList("sim")}

                          <SimTypeField rows={simRows} />

                          <div>
                            <label className="block text-[10px] text-slate-450 mb-1 font-medium flex items-center gap-1">
                              <Lock className="w-3 h-3" /> الفني المسؤول (من عهدة الجهاز)
                            </label>
                            <div
                              className={`bg-[#F8FAFC] border rounded-lg px-2.5 py-1.5 text-xs flex items-center gap-1.5 ${
                                primaryDeviceLookup?.technician
                                  ? "border-[#18B2B0]/30 text-[#18B2B0]"
                                  : "border-[#E2E8F0] text-[#6B7280]"
                              }`}
                            >
                              {primaryDeviceLookup?.technician ? (
                                <>
                                  👤 {primaryDeviceLookup.technician.fullName}
                                  <span className="text-[10px] text-[#6B7280] font-mono bg-[#F8FAFC] px-1 py-0.5 rounded ml-auto">
                                    {primaryDeviceLookup.technician.technicianCode ??
                                      primaryDeviceLookup.technician.username}
                                  </span>
                                </>
                              ) : (
                                <span className="text-[10px]">امسح رقم الجهاز لتحديد الفني من العهدة</span>
                              )}
                            </div>
                            {request.tecName && (
                              <p className="mt-1 text-[10px] text-[#6B7280]">
                                تعيين الطلب (مرجعي): {request.tecName}
                              </p>
                            )}
                          </div>
                        </>
                      ) : (
                        <div className="flex items-start gap-2 rounded-lg border border-[#F4B740]/35 bg-amber-500/10 px-3 py-2.5">
                          <Info className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-[11px] font-semibold text-amber-300">
                              طلب غير مكتمل — بدون سيريالات وبدون خصم
                            </p>
                            <p className="text-[10px] text-amber-200/70 mt-0.5">
                              لا يُطلب إدخال أجهزة أو شرائح، ولن يُخصم شيء من عهدة الفني عند الحفظ.
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-slate-450 mb-1 font-medium">تاريخ التنفيذ</label>
                          <input
                            type="date"
                            value={currentForm.deliveryDate || ""}
                            onChange={(e) => handleChange("deliveryDate", e.target.value)}
                            className="w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0]"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] text-slate-450 mb-1 font-medium">وقت التنفيذ</label>
                          <input
                            type="time"
                            value={currentForm.time || ""}
                            onChange={(e) => handleChange("time", e.target.value)}
                            className="w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0]"
                          />
                        </div>
                      </div>

                      <div className="border-t border-[#E2E8F0] pt-3 mt-2">
                        <label className="block text-[11px] text-[#18B2B0] mb-2 font-semibold">المواد الاستهلاكية المسلمة للعميل (تُخصم من رصيد الفني)</label>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] text-slate-450 mb-1 font-medium">تسليم ورق رول</label>
                            <select
                              value={currentForm.paperRoll || ""}
                              onChange={(e) => handleChange("paperRoll", e.target.value)}
                              className="w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0]"
                            >
                              <option value="">اختر</option>
                              <option value="Yes">نعم</option>
                              <option value="No">لا</option>
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-450 mb-1 font-medium">كمية ورق رول (عدد)</label>
                            <input
                              type="number"
                              min="0"
                              value={currentForm.paperRollQty ?? 0}
                              onChange={(e) => handleChange("paperRollQty", e.target.value)}
                              className="w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0]"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-450 mb-1 font-medium">بطاقات نيوليب (عدد)</label>
                            <input
                              type="number"
                              min="0"
                              value={currentForm.nulipCardsQty ?? 0}
                              onChange={(e) => handleChange("nulipCardsQty", e.target.value)}
                              className="w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0]"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] text-slate-450 mb-1 font-medium">ملصقات / استيكرات (عدد)</label>
                            <input
                              type="number"
                              min="0"
                              value={currentForm.stickersQty ?? 0}
                              onChange={(e) => handleChange("stickersQty", e.target.value)}
                              className="w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0]"
                            />
                          </div>
                        </div>
                      </div>

                      {currentForm.installationStatus === "Not Completed" && (
                        <div>
                          <label className="block text-[10px] text-slate-450 mb-1 font-medium">سبب الفشل *</label>
                          <select
                            value={currentForm.responseReasonCode || ""}
                            onChange={(e) => handleChange("responseReasonCode", e.target.value)}
                            className="w-full rassco-glass border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-xs text-[#2D3135] outline-none focus:border-[#18B2B0]"
                          >
                            <option value="">اختر السبب</option>
                            {lookups?.failureReasons.map((r) => (
                              <option key={r.id} value={r.code}>
                                {r.labelAr}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between border-t border-[#E2E8F0] pt-3 mt-4">
                  {phase === 1 ? (
                    <>
                      <div />
                      <button
                        type="button"
                        onClick={handleNextPhase}
                        className="bg-[#18B2B0] hover:bg-[#149D9B] text-white text-[10px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1"
                      >
                        التالي (التنفيذ الميداني)
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setPhase(1)}
                        className="bg-[#4B5563] hover:bg-[#374151] text-white text-[10px] font-semibold px-3 py-2 rounded-lg flex items-center gap-1"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                        السابق (التحقق)
                      </button>
                      <button
                        type="button"
                        onClick={handleSave}
                        disabled={mutation.isPending}
                        className="bg-[#18B2B0] hover:bg-[#149D9B] disabled:opacity-50 text-white text-[10px] font-semibold px-4 py-2 rounded-lg flex items-center gap-1"
                      >
                        {mutation.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Save className="w-3.5 h-3.5" />
                        )}
                        {completing ? "حفظ وإكمال وخصم العهدة" : "حفظ فقط (بدون خصم)"}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {completing ? (
              <div className="flex items-start gap-2.5 bg-[#18B2B0]/10 border border-[#18B2B0]/25 rounded-xl p-3.5">
                <CheckCircle2 className="w-4 h-4 text-[#18B2B0] mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-[#18B2B0]">خصم تلقائي نشط</p>
                  <p className="text-[10px] text-[#18B2B0]/70 mt-0.5">
                    عند الإكمال سيُخصم كل جهاز وشريحة مدخلة من عهدة الفني الظاهر أعلاه.
                  </p>
                </div>
              </div>
            ) : currentForm.installationStatus ? (
              <div className="flex items-start gap-2.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl p-3.5">
                <Info className="w-4 h-4 text-[#6B7280] mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-[#4B5563]">بدون خصم من العهدة</p>
                  <p className="text-[10px] text-[#6B7280] mt-0.5">
                    الحالة غير مكتملة — الحفظ يغلق/يحدّث الطلب فقط دون طلب سيريالات ودون خصم مخزون.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
