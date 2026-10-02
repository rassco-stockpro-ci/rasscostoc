import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SimTypeField } from "@/components/courier-sim-type-field";
import { deriveSimTypes } from "@/lib/sim-type";
import {
  Loader2,
  ArrowRight,
  Package,
  MapPin,
  Phone,
  Calendar,
  Hash,
  Cpu,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  Save,
  ChevronLeft,
  ChevronRight,
  Search,
  ShieldAlert,
  BadgeCheck,
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
}

function DetailRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <span className="text-[#6B7280] text-sm min-w-[140px]">{label}</span>
      <span className="text-[#2D3135] text-sm font-medium">{value}</span>
    </div>
  );
}

export default function CourierRequestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const requestId = Number(id);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const { data: request, isLoading } = useQuery<RequestDetail>({
    queryKey: ["/api/courier/requests", requestId],
    queryFn: () =>
      apiRequest("GET", `/api/courier/requests/${requestId}`).then((r) => r.json()),
    enabled: !!requestId,
  });

  const { data: lookups } = useQuery<Lookups>({
    queryKey: ["/api/courier/lookups"],
    queryFn: () => apiRequest("GET", "/api/courier/lookups").then((r) => r.json()),
  });

  const [form, setForm] = useState<Partial<Execution>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [phase, setPhase] = useState<1 | 2>(1);

  // ── Serial Lookup State ───────────────────────────────────────────────────
  interface SerialLookupResult {
    found: boolean;
    normalized?: string;
    itemType?: { id: string; nameAr: string; category: string; carrierName: string | null } | null;
    technician?: { id: string; fullName: string; username: string; technicianCode: string | null } | null;
    custodyStatus?: string | null;
    inActiveCustody?: boolean;
    linkedRequest?: { requestId: number; terminalId?: string } | null;
    ownershipValid?: boolean;
    message?: string;
  }
  const [deviceLookup, setDeviceLookup] = useState<SerialLookupResult | null>(null);
  const [simLookup, setSimLookup] = useState<SerialLookupResult | null>(null);
  const [snLookupLoading, setSnLookupLoading] = useState(false);
  const [simLookupLoading, setSimLookupLoading] = useState(false);

  const [extraDevices, setExtraDevices] = useState<string[]>([]);
  const [extraSims, setExtraSims] = useState<string[]>([]);

  const ownershipMismatch =
    deviceLookup?.found &&
    simLookup?.found &&
    deviceLookup?.technician?.id &&
    simLookup?.technician?.id &&
    deviceLookup.technician.id !== simLookup.technician.id;

  const doSerialLookup = useCallback(async (sn: string, role: "device" | "sim") => {
    if (!sn.trim()) return;
    if (role === "device") setSnLookupLoading(true);
    else setSimLookupLoading(true);
    try {
      const res = await apiRequest("POST", "/api/courier/serial-lookup", { sn: sn.trim() });
      const data: SerialLookupResult = await res.json();
      if (role === "device") {
        setDeviceLookup(data);
        if (data.found && data.technician) {
          // Auto-fill technician from lookup (READ-ONLY source of truth)
          setForm((prev) => ({
            ...prev,
            technicianCode: data.technician!.technicianCode ?? data.technician!.username,
            salesTechnician: data.technician!.fullName,
          }));
          // (a DEVICE's item type never sets the SIM type)
        }
      } else {
        setSimLookup(data);
        if (data.found) {
          // Prefer corrected ICCID from engine (e.g. 99966 → 89966 OCR typo)
          if (data.normalized && data.normalized !== sn.trim()) {
            setForm((prev) => ({ ...prev, simSerial: data.normalized }));
          }
          // SIM type is derived from this lookup for display (SimTypeField), never stored in the form.
        }
      }
    } catch {
      toast({ title: "تعذّر البحث", description: `فشل البحث عن الرقم: ${sn}`, variant: "destructive" });
    } finally {
      if (role === "device") setSnLookupLoading(false);
      else setSimLookupLoading(false);
    }
  }, [toast]);

  const [loadedSerials, setLoadedSerials] = useState(false);

  useEffect(() => {
    if (request && !loadedSerials) {
      setLoadedSerials(true);
      // Strip polluted assignment name from prior saves — custody lookup is source of truth
      if (
        request.execution?.salesTechnician &&
        request.tecName &&
        request.execution.salesTechnician === request.tecName
      ) {
        setForm((prev) => ({
          ...prev,
          salesTechnician: undefined,
          technicianCode: undefined,
        }));
      }
      const sn = request.execution?.sn;
      const simSerial = request.execution?.simSerial || request.simSn;
      if (sn) {
        doSerialLookup(sn, "device");
      }
      if (simSerial) {
        doSerialLookup(simSerial, "sim");
      }
    }
  }, [request, loadedSerials, doSerialLookup]);

  const mutation = useMutation({
    mutationFn: (data: Partial<Execution>) =>
      apiRequest("POST", `/api/courier/executions/${requestId}`, data).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "تم الحفظ بنجاح", description: "تم حفظ بيانات التحقق والتنفيذ بنجاح وتحديث العهدة والمخزون." });
      queryClient.invalidateQueries({ queryKey: ["/api/courier/requests", requestId] });
      queryClient.invalidateQueries({ queryKey: ["/api/courier/dashboard/stats"] });
      setIsDirty(false);
      setPhase(1);
      setLocation("/courier/requests");
    },
    onError: (err: any) => {
      const msg = err?.message || "فشل حفظ البيانات، يرجى المحاولة مجدداً.";
      toast({ title: "خطأ في الحفظ", description: msg, variant: "destructive" });
    },
  });

  const exec = request?.execution;
  const currentForm = { ...exec, ...form };
  const completingStatus =
    currentForm.installationStatus === "Installation Completed" ||
    currentForm.installationStatus === "Installation Completed - NL";

  const handleChange = (field: keyof Execution, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
  };

  const handleNextPhase = () => {
    if (!currentForm.installationStatus) {
      toast({
        title: "تنبيه",
        description: "يرجى تحديد حالة التركيب أولاً.",
        variant: "destructive",
      });
      return;
    }
    setPhase(2);
  };

  const handleSave = () => {
    if (!currentForm.installationStatus) {
      toast({ title: "تنبيه", description: "يرجى تحديد حالة التركيب أولاً.", variant: "destructive" });
      return;
    }
    if (ownershipMismatch) {
      toast({ title: "خطأ في العهدة", description: "الجهاز والشريحة ينتميان لفنيين مختلفين. لا يمكن إغلاق الطلب.", variant: "destructive" });
      return;
    }

    if (completingStatus) {
      const deviceSerials = [currentForm.sn, ...extraDevices].map((s) => (s || "").trim()).filter(Boolean);
      const simSerials = [currentForm.simSerial, ...extraSims].map((s) => (s || "").trim()).filter(Boolean);
      if (deviceSerials.length === 0) {
        toast({ title: "تنبيه", description: "أدخل الرقم التسلسلي للجهاز قبل الإكمال.", variant: "destructive" });
        return;
      }
      if (!deviceLookup?.found || !deviceLookup?.technician) {
        toast({
          title: "لم يتم التعرف على الفني من العهدة",
          description: "امسح/أدخل رقم الجهاز المرتبط بمخزون الفني حتى يظهر اسمه تلقائياً. لا يُعتمد اسم التعيين للإكمال.",
          variant: "destructive",
        });
        return;
      }
      if (!deviceLookup.inActiveCustody) {
        toast({
          title: "الجهاز ليس في عهدة نشطة",
          description: `الحالة الحالية: ${deviceLookup.custodyStatus ?? "غير معروفة"}`,
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
        simType: deriveSimTypes([{ value: currentForm.simSerial ?? "", lookup: simLookup }]).primary ?? undefined,
        customerNotes: currentForm.customerNotes,
        responseReasonCode: currentForm.responseReasonCode,
        version: currentForm.version,
        technicianCode: deviceLookup.technician.technicianCode ?? deviceLookup.technician.username,
        salesTechnician: deviceLookup.technician.fullName,
      } as any);
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
      pushBack: currentForm.pushBack,
      version: currentForm.version,
    } as any);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[#6B7280]">
        <Loader2 className="animate-spin w-6 h-6 mr-2" />
        <span>جاري التحميل...</span>
      </div>
    );
  }

  if (!request) {
    return (
      <div className="text-center py-20 text-[#6B7280]">
        الطلب غير موجود
      </div>
    );
  }

  const statusStyle =
    currentForm.installationStatus?.includes("Completed")
      ? "text-[#18B2B0]"
      : currentForm.installationStatus === "Not Completed"
      ? "text-red-400"
      : "text-amber-400";

  return (
    <div dir="rtl" className="rassco-page space-y-6 max-w-5xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[#6B7280]">
        <Link href="/courier/requests" className="hover:text-[#2D3135] transition-colors">
          قائمة الطلبات
        </Link>
        <ArrowRight className="w-4 h-4" />
        <span className="text-[#2D3135] font-mono">#{request.id}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#2D3135] flex items-center gap-2">
            <Package className="w-5 h-5 text-[#18B2B0]" />
            تفاصيل الطلب #{request.id}
          </h1>
          {currentForm.installationStatus && (
            <p className={`text-sm font-medium mt-1 ${statusStyle}`}>
              {currentForm.installationStatus === "Installation Completed" ? "مكتمل" : 
               currentForm.installationStatus === "Not Completed" ? "غير مكتمل" :
               currentForm.installationStatus === "Customer Not Answering" ? "العميل لا يرد" :
               currentForm.installationStatus === "In Progress" ? "تحت الإجراء" : 
               currentForm.installationStatus}
            </p>
          )}
        </div>
        {phase === 1 ? (
          <button
            onClick={handleNextPhase}
            className="flex items-center gap-2 bg-[#18B2B0] hover:bg-[#149D9B] text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
          >
            التالي (بيانات التنفيذ)
            <ChevronLeft className="w-4 h-4" />
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setPhase(1)}
              className="bg-[#4B5563] hover:bg-[#374151] text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
            >
              السابق
            </button>
            <button
              onClick={handleSave}
              disabled={!isDirty || mutation.isPending}
              className="flex items-center gap-2 bg-[#18B2B0] hover:bg-[#149D9B] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-5 py-2.5 rounded-lg transition-colors"
            >
              {mutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {completingStatus ? "حفظ وإكمال وخصم العهدة" : "حفظ فقط (بدون خصم)"}
            </button>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Request Raw Data */}
        <div className="rassco-glass border border-[#E2E8F0] rounded-xl p-6 shadow space-y-3">
          <h2 className="text-sm font-semibold text-[#4B5563] uppercase tracking-wide border-b border-[#E2E8F0] pb-2 mb-4">
            بيانات الطلب الأصلية
          </h2>
          <DetailRow label="التاريخ" value={request.date} />
          <DetailRow label="TID" value={request.tid} />
          <DetailRow label="Terminal ID" value={request.terminalId} />
          <DetailRow label="اسم العميل" value={request.customerName} />
          <DetailRow label="اسم التاجر" value={request.retailerName} />
          <DetailRow label="المدينة" value={request.city} />
          <DetailRow label="المدينة (TEC)" value={request.cityTec} />
          <DetailRow label="العنوان" value={request.addressAr} />
          <DetailRow label="الجوال" value={request.mobile} />
          <DetailRow label="الجوال 2" value={request.mobile2} />
          <DetailRow label="اسم الفني (تعيين الطلب)" value={request.tecName} />
          <DetailRow label="نوع التركيب" value={request.installationType} />
          <DetailRow label="نوع الجهاز" value={request.vendorType} />
          <DetailRow label="SIM" value={request.sim} />
          <DetailRow label="OTP" value={request.otp} />
          <DetailRow label="رقم الحادثة" value={request.incidentNumber} />
          <DetailRow label="TRSM" value={request.trsm} />
        </div>

        {/* Execution Form Wizard */}
        <div className="rassco-glass border border-[#E2E8F0] rounded-xl p-6 shadow space-y-4 flex flex-col justify-between min-h-[500px]">
          <div>
            <h2 className="text-sm font-semibold text-[#4B5563] uppercase tracking-wide border-b border-[#E2E8F0] pb-2 mb-4">
              {phase === 1 ? "شاشة التحقق والاعتماد (المرحلة الأولى)" : "بيانات التنفيذ (المرحلة الثانية)"}
            </h2>

            {/* Premium Step Indicator */}
            <div className="flex items-center justify-between mb-6 bg-[#F8FAFC] p-3 rounded-lg border border-[#E2E8F0]">
              <button
                type="button"
                onClick={() => setPhase(1)}
                className="flex items-center gap-2 cursor-pointer"
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${phase === 1 ? 'bg-[#18B2B0] text-white shadow shadow-[#18B2B0]/30' : 'bg-[#18B2B0]/20 text-[#18B2B0] hover:bg-[#18B2B0]/30'}`}>1</span>
                <span className={`text-xs font-semibold transition-all ${phase === 1 ? 'text-[#2D3135]' : 'text-[#6B7280] hover:text-[#4B5563]'}`}>شاشة التحقق</span>
              </button>
              <div className="flex-1 mx-4 h-0.5 bg-[#E2E8F0]"></div>
              <button
                type="button"
                disabled={!currentForm.installationStatus}
                onClick={() => setPhase(2)}
                className="flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${phase === 2 ? 'bg-[#18B2B0] text-white shadow shadow-[#18B2B0]/30' : 'bg-[#E2E8F0] text-[#6B7280]'}`}>2</span>
                <span className={`text-xs font-semibold transition-all ${phase === 2 ? 'text-[#2D3135]' : 'text-[#6B7280]'}`}>بيانات التنفيذ</span>
              </button>
            </div>

            {phase === 1 ? (
              /* PHASE 1 FORM FIELDS */
              <div className="space-y-4">
                {/* 1. Request Priority Level */}
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1.5 font-medium">مستوى أولوية الطلب</label>
                  <select
                    value={currentForm.requestPriorityLevel || ""}
                    onChange={(e) => handleChange("requestPriorityLevel", e.target.value)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                  >
                    <option value="">اختر الأولوية</option>
                    <option value="Low">منخفض</option>
                    <option value="Medium">متوسط</option>
                    <option value="High">مرتفع</option>
                    <option value="Urgent">عاجل</option>
                  </select>
                </div>

                {/* 2. Action / إجراء الطلب */}
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1.5 font-medium">إجراء الطلب</label>
                  <select
                    value={currentForm.pushBack || ""}
                    onChange={(e) => handleChange("pushBack", e.target.value)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                  >
                    <option value="">بدون إجراء</option>
                    <option value="Return to Tech">إعادة للفني</option>
                    <option value="Return to Supervisor">إعادة للمشرف</option>
                    <option value="Return to Admin">إعادة للإدارة</option>
                  </select>
                </div>

                {/* 3. Installation Status */}
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1.5 font-medium">حالة التركيب *</label>
                  <select
                    value={currentForm.installationStatus || ""}
                    onChange={(e) => handleChange("installationStatus", e.target.value)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                  >
                    <option value="">اختر الحالة</option>
                    <option value="Installation Completed">مكتمل</option>
                    <option value="Not Completed">غير مكتمل</option>
                    <option value="Customer Not Answering">العميل لا يرد</option>
                    <option value="In Progress">تحت الإجراء</option>
                  </select>
                </div>

                {/* 4. Response Date */}
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1.5 font-medium">تاريخ الرد (تاريخ المراجعة)</label>
                  <input
                    type="date"
                    value={currentForm.responseDate || ""}
                    onChange={(e) => handleChange("responseDate", e.target.value)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                  />
                </div>

                {/* 5. Client Notes / ملاحظات العميل */}
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1.5 font-medium">ملاحظات العميل / المشرف</label>
                  <textarea
                    value={currentForm.customerNotes || ""}
                    onChange={(e) => handleChange("customerNotes", e.target.value)}
                    rows={4}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] placeholder-[#9CA3AF] outline-none focus:border-[#18B2B0] resize-none font-sans"
                    placeholder="أي ملاحظات أو تعليقات تخص العميل أو مستوى الخدمة..."
                  />
                </div>
              </div>
            ) : (
              /* PHASE 2 FORM FIELDS — Serial-Driven when completed */
              <div className="space-y-4">

                {!completingStatus ? (
                  <div className="flex items-start gap-2 bg-amber-500/10 border border-[#F4B740]/35 rounded-lg px-3 py-2.5">
                    <Info className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-xs font-bold text-amber-300">طلب غير مكتمل — بدون سيريالات وبدون خصم</p>
                      <p className="text-xs text-amber-200/70 mt-0.5">
                        لا يُطلب إدخال أجهزة أو شرائح، ولن يُخصم شيء من عهدة الفني عند الحفظ.
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                {/* Ownership Mismatch Alert */}
                {ownershipMismatch && (
                  <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5">
                    <ShieldAlert className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-xs font-bold text-red-400">تعارض في العهدة — لا يمكن الإغلاق</p>
                      <p className="text-xs text-red-400/70 mt-0.5">
                        الجهاز ({deviceLookup?.technician?.fullName}) والشريحة ({simLookup?.technician?.fullName}) ينتميان لفنيين مختلفين.
                      </p>
                    </div>
                  </div>
                )}

                {/* Device SN — with lookup */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs text-[#6B7280] font-medium">الرقم التسلسلي للجهاز (SN) *</label>
                    <button
                      type="button"
                      onClick={() => { setExtraDevices((p) => [...p, ""]); setIsDirty(true); }}
                      className="text-xs text-[#18B2B0] hover:text-[#18B2B0] flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> إضافة جهاز
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={currentForm.sn || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        handleChange("sn", val);
                        setDeviceLookup(null);
                        if (val.trim().length >= 9) {
                          doSerialLookup(val.trim(), "device");
                        }
                      }}
                      onBlur={(e) => { if (e.target.value.trim()) doSerialLookup(e.target.value.trim(), "device"); }}
                      placeholder="أدخل أو امسح الرقم التسلسلي..."
                      className="flex-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] placeholder-[#9CA3AF] outline-none focus:border-[#18B2B0] font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => { if (currentForm.sn?.trim()) doSerialLookup(currentForm.sn.trim(), "device"); }}
                      className="bg-[#18B2B0]/15 hover:bg-[#149D9B]/60 border border-[#18B2B0]/30 text-[#18B2B0] px-3 rounded-lg transition-colors"
                    >
                      {snLookupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    </button>
                  </div>
                  {deviceLookup && (
                    <div className={`mt-1.5 flex items-center gap-2 text-xs px-2 py-1 rounded-md ${
                      deviceLookup.found && deviceLookup.inActiveCustody
                        ? "bg-[#18B2B0]/10 text-[#18B2B0]"
                        : "bg-red-500/10 text-red-400"
                    }`}>
                      {deviceLookup.found && deviceLookup.inActiveCustody
                        ? <BadgeCheck className="w-3.5 h-3.5" />
                        : <XCircle className="w-3.5 h-3.5" />}
                      {deviceLookup.found
                        ? `${deviceLookup.itemType?.nameAr ?? "جهاز"} · ${deviceLookup.custodyStatus}${deviceLookup.technician ? ` · ${deviceLookup.technician.fullName}` : ""}`
                        : (deviceLookup.message ?? "الرقم التسلسلي غير موجود")}
                    </div>
                  )}
                  {extraDevices.map((sn, idx) => (
                    <div key={`dev-extra-${idx}`} className="flex gap-2 mt-2">
                      <input
                        value={sn}
                        onChange={(e) => {
                          const next = [...extraDevices];
                          next[idx] = e.target.value;
                          setExtraDevices(next);
                          setIsDirty(true);
                        }}
                        placeholder={`جهاز إضافي ${idx + 2}`}
                        className="flex-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] font-mono outline-none focus:border-[#18B2B0]"
                      />
                      <button
                        type="button"
                        onClick={() => { setExtraDevices((p) => p.filter((_, i) => i !== idx)); setIsDirty(true); }}
                        className="bg-red-900/30 border border-red-800/40 text-red-300 px-3 rounded-lg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* SIM Serial — with lookup */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs text-[#6B7280] font-medium">الرقم التسلسلي للشريحة (ICCID)</label>
                    <button
                      type="button"
                      onClick={() => { setExtraSims((p) => [...p, ""]); setIsDirty(true); }}
                      className="text-xs text-[#18B2B0] hover:text-[#18B2B0] flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> إضافة شريحة
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={currentForm.simSerial || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        handleChange("simSerial", val);
                        setSimLookup(null);
                        if (val.trim().length >= 18) {
                          doSerialLookup(val.trim(), "sim");
                        }
                      }}
                      onBlur={(e) => { if (e.target.value.trim()) doSerialLookup(e.target.value.trim(), "sim"); }}
                      placeholder="89..."
                      className="flex-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] placeholder-[#9CA3AF] outline-none focus:border-[#18B2B0] font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => { if (currentForm.simSerial?.trim()) doSerialLookup(currentForm.simSerial.trim(), "sim"); }}
                      className="bg-[#18B2B0]/15 hover:bg-[#149D9B]/60 border border-[#18B2B0]/30 text-[#18B2B0] px-3 rounded-lg transition-colors"
                    >
                      {simLookupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    </button>
                  </div>
                  {simLookup && (
                    <div className={`mt-1.5 flex items-center gap-2 text-xs px-2 py-1 rounded-md ${
                      simLookup.found && simLookup.inActiveCustody
                        ? "bg-[#18B2B0]/10 text-[#18B2B0]"
                        : "bg-red-500/10 text-red-400"
                    }`}>
                      {simLookup.found && simLookup.inActiveCustody
                        ? <BadgeCheck className="w-3.5 h-3.5" />
                        : <XCircle className="w-3.5 h-3.5" />}
                      {simLookup.found
                        ? `${simLookup.itemType?.nameAr ?? "شريحة"} · ${simLookup.itemType?.carrierName ?? ""} · ${simLookup.custodyStatus}`
                        : (simLookup.message ?? "الرقم التسلسلي غير موجود")}
                    </div>
                  )}
                  {extraSims.map((sn, idx) => (
                    <div key={`sim-extra-${idx}`} className="flex gap-2 mt-2">
                      <input
                        value={sn}
                        onChange={(e) => {
                          const next = [...extraSims];
                          next[idx] = e.target.value;
                          setExtraSims(next);
                          setIsDirty(true);
                        }}
                        placeholder={`شريحة إضافية ${idx + 2}`}
                        className="flex-1 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] font-mono outline-none focus:border-[#18B2B0]"
                      />
                      <button
                        type="button"
                        onClick={() => { setExtraSims((p) => p.filter((_, i) => i !== idx)); setIsDirty(true); }}
                        className="bg-red-900/30 border border-red-800/40 text-red-300 px-3 rounded-lg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* SIM Type — READ-ONLY, derived from the SIM's inventory item type (serial lookup) */}
                <SimTypeField
                  rows={[{ value: currentForm.simSerial ?? "", lookup: simLookup }]}
                  labelClassName="block text-xs text-[#6B7280] mb-1.5 font-medium"
                  boxClassName="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135]"
                />

                {/* Technician — READ-ONLY from serial custody; warn if assignment differs */}
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1.5 font-medium flex items-center gap-1">
                    <Lock className="w-3 h-3" /> الفني المسؤول (من عهدة الجهاز)
                  </label>
                  <div className={`bg-[#F8FAFC] border rounded-lg px-3 py-2 text-sm font-medium flex items-center gap-2 ${
                    deviceLookup?.technician ? "border-[#18B2B0]/30 text-[#18B2B0]" : "border-[#E2E8F0] text-[#6B7280]"
                  }`}>
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      deviceLookup?.technician ? "bg-[#18B2B0] animate-pulse" : "bg-[#6B7280]"
                    }`} />
                    {deviceLookup?.technician
                      ? <>
                          👤 {deviceLookup.technician.fullName}
                          <span className="text-xs text-[#6B7280] font-mono bg-[#F8FAFC] px-1.5 py-0.5 rounded ml-auto">
                            {deviceLookup.technician.technicianCode ?? deviceLookup.technician.username}
                          </span>
                        </>
                      : <span className="text-[#6B7280] text-xs">امسح رقم الجهاز لتحديد الفني تلقائياً من العهدة</span>
                    }
                  </div>
                  {request.tecName && (
                    <p className="mt-1 text-[11px] text-[#6B7280]">
                      تعيين الطلب (مرجعي فقط): <span className="text-[#6B7280]">{request.tecName}</span>
                      {deviceLookup?.technician ? (
                        request.tecName.replace(/_/g, " ").toLowerCase() !==
                          (deviceLookup.technician.fullName || "").toLowerCase() && (
                          <span className="text-amber-400 block mt-0.5">
                            ⚠ الخصم من عهدة: {deviceLookup.technician.fullName} — وليس من اسم التعيين.
                          </span>
                        )
                      ) : (
                        <span className="text-red-400/80 block mt-0.5">
                          أدخل رقم جهاز موجود في مخزون الفني ليظهر اسمه هنا تلقائياً.
                        </span>
                      )}
                    </p>
                  )}
                </div>
                  </>
                )}

                {/* Delivery Date & Time */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1.5 font-medium">تاريخ التنفيذ</label>
                    <input
                      type="date"
                      value={currentForm.deliveryDate || ""}
                      onChange={(e) => handleChange("deliveryDate", e.target.value)}
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1.5 font-medium">وقت التنفيذ</label>
                    <input
                      type="time"
                      value={currentForm.time || ""}
                      onChange={(e) => handleChange("time", e.target.value)}
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                    />
                  </div>
                </div>

                {/* Consumables Section */}
                <div className="border-t border-[#E2E8F0] pt-3 mt-2 space-y-3">
                  <label className="block text-xs text-[#18B2B0] font-semibold">المواد الاستهلاكية المسلمة للعميل (تُخصم من رصيد الفني)</label>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1 font-medium">تسليم ورق رول</label>
                      <select
                        value={currentForm.paperRoll || ""}
                        onChange={(e) => handleChange("paperRoll", e.target.value)}
                        className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                      >
                        <option value="">اختر</option>
                        <option value="Yes">نعم</option>
                        <option value="No">لا</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1 font-medium">كمية ورق رول (عدد)</label>
                      <input
                        type="number"
                        min="0"
                        value={currentForm.paperRollQty ?? 0}
                        onChange={(e) => handleChange("paperRollQty", e.target.value)}
                        className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1 font-medium">بطاقات نيوليب (عدد)</label>
                      <input
                        type="number"
                        min="0"
                        value={currentForm.nulipCardsQty ?? 0}
                        onChange={(e) => handleChange("nulipCardsQty", e.target.value)}
                        className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1 font-medium">ملصقات / استيكرات (عدد)</label>
                      <input
                        type="number"
                        min="0"
                        value={currentForm.stickersQty ?? 0}
                        onChange={(e) => handleChange("stickersQty", e.target.value)}
                        className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
                      />
                    </div>
                  </div>
                </div>

                {/* Failure Reason (conditional) */}
                {currentForm.installationStatus === "Not Completed" && (
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1.5 font-medium">سبب الفشل *</label>
                    <select
                      value={currentForm.responseReasonCode || ""}
                      onChange={(e) => handleChange("responseReasonCode", e.target.value)}
                      className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2 text-sm text-[#2D3135] outline-none focus:border-[#18B2B0]"
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

          {/* Wizard Action Buttons */}
          <div className="flex items-center justify-between border-t border-[#E2E8F0] pt-4 mt-6">
            {phase === 1 ? (
              <>
                <div />
                <button
                  type="button"
                  onClick={handleNextPhase}
                  className="bg-[#18B2B0] hover:bg-[#149D9B] text-white text-xs font-semibold px-5 py-2.5 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  التالي (بيانات التنفيذ)
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setPhase(1)}
                  className="bg-[#4B5563] hover:bg-[#374151] text-white text-xs font-semibold px-4 py-2.5 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <ChevronRight className="w-4 h-4" />
                  السابق (بيانات التحقق)
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!isDirty || mutation.isPending}
                  className="bg-[#18B2B0] hover:bg-[#149D9B] disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold px-5 py-2.5 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  {mutation.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  {completingStatus ? "حفظ وإكمال وخصم العهدة" : "حفظ فقط (بدون خصم)"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Auto-deduction Info Banner */}
      {completingStatus ? (
        <div className="flex items-start gap-3 bg-[#18B2B0]/10 border border-[#18B2B0]/25 rounded-xl p-4">
          <CheckCircle2 className="w-5 h-5 text-[#18B2B0] mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-[#18B2B0]">خصم تلقائي من المخزون والعهدة المسلسلة</p>
            <p className="text-xs text-[#18B2B0]/70 mt-0.5">
              عند الحفظ بحالة "مكتمل"، سيتم خصم كل الأجهزة والشرائح المُدخلة تلقائياً من عهدة الفني (Scan-Out).
            </p>
          </div>
        </div>
      ) : currentForm.installationStatus ? (
        <div className="flex items-start gap-3 rassco-glass border border-[#E2E8F0] rounded-xl p-4">
          <Info className="w-5 h-5 text-[#6B7280] mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-[#4B5563]">بدون خصم من العهدة</p>
            <p className="text-xs text-[#6B7280] mt-0.5">
              الحالة غير مكتملة — الحفظ يحدّث الطلب فقط دون طلب سيريالات ودون خصم مخزون.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
