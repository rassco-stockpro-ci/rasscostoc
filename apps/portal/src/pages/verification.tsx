import { useTranslation } from "@/lib/language";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { 
  QrCode, 
  Search, 
  User, 
  Calendar, 
  Tag, 
  AlertCircle, 
  CheckCircle, 
  Smartphone, 
  Handshake, 
  FileText, 
  Cable, 
  Boxes, 
  History, 
  MapPin, 
  ArrowRight,
  Copy,
  Check,
  Sparkles,
  ShieldCheck,
  RotateCcw,
  Building2,
  PackageCheck,
  Clock,
  ArrowUpRight,
  Phone,
  MessageCircle,
  AtSign,
  Activity,
  GitCommit,
  UserCheck,
  ChevronLeft,
  Filter,
  ArrowUpDown,
  FileCheck,
  Info,
  ExternalLink,
  Layers,
  Cpu,
  Mail,
  Briefcase,
  Hash,
  Globe,
  Monitor,
  Pencil,
  Trash2
} from "lucide-react";
import { Link } from "wouter";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useActiveItemTypes } from "@/hooks/use-item-types";
import { useAuth } from "@/lib/auth";
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

export interface UnifiedAssetTrackingData {
  asset: {
    id: string;
    serialNumber: string;
    barcode: string;
    status: string;
    statusLabel: string;
    statusColor: string;
    itemTypeId: string | null;
    itemTypeName: string | null;
    category: string | null;
    carrierName: string | null;
    createdAt: string;
    updatedAt: string | null;
  };
  currentCustodian: {
    id: string;
    fullName: string;
    username: string;
    employeeCode: string | null;
    jobTitle: string | null;
    avatarUrl: string | null;
    phone: string | null;
    email: string | null;
    city: string | null;
    regionName: string | null;
    warehouseName: string | null;
    isActive: boolean;
    receivedAt: string | null;
    custodyDurationDays: number;
    lastLocation: string | null;
  } | null;
  lastActionBy: {
    id: string;
    fullName: string;
    username: string;
    avatarUrl: string | null;
    role: string;
    roleLabel: string;
    department: string | null;
    regionName: string | null;
    actionType: string;
    actionLabel: string;
    occurredAt: string;
    actionNumber: string;
    notes: string | null;
  } | null;
  closure: {
    isClosed: boolean;
    status: string;
    statusLabel: string;
    closedAt: string | null;
    closedById: string | null;
    closedByName: string | null;
    closedByUsername: string | null;
    closedByAvatarUrl: string | null;
    closedByRole: string | null;
    orderNumber: string | null;
    clientName: string | null;
    clientNumber: string | null;
    notes: string | null;
    durationFromIntakeDays: number | null;
  } | null;
  linkedIdentifiers: Array<{
    type: string;
    serialNumber: string;
    carrierName?: string | null;
    linkedAt?: string | null;
    linkedBy?: string | null;
  }>;
  summary: {
    currentStatusLabel: string;
    statusColor: string;
    custodianName: string;
    locationName: string;
    lastUpdatedHuman: string;
    totalMovements: number;
    lastActionName: string;
    lastActorName: string;
  };
  timeline: Array<{
    eventId: string;
    eventType: string;
    eventLabel: string;
    title: string;
    description: string | null;
    statusFrom: string;
    statusFromLabel: string;
    statusTo: string;
    statusToLabel: string;
    statusColor: string;
    actor: {
      id: string;
      name: string;
      username: string;
      avatarUrl: string | null;
      role: string;
    };
    technician?: {
      id: string;
      name: string;
    } | null;
    warehouse?: {
      name: string;
    } | null;
    region?: {
      name: string;
    } | null;
    occurredAt: string;
    location?: {
      name: string;
    } | null;
    referenceId?: string | null;
    notes?: string | null;
    metadata?: Record<string, any>;
  }>;
}

export default function VerificationPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdminOrSupervisor = !user || user.role === "admin" || user.role === "supervisor";

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editSerial, setEditSerial] = useState("");
  const [editCarrier, setEditCarrier] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const openEditModal = () => {
    if (!trackingData?.asset) return;
    setEditSerial(trackingData.asset.serialNumber || "");
    setEditCarrier(trackingData.asset.carrierName || "");
    setEditStatus(trackingData.asset.status || "IN_WAREHOUSE");
    setIsEditOpen(true);
  };

  const updateAssetMutation = useMutation({
    mutationFn: async () => {
      if (!trackingData?.asset?.id) throw new Error("معرّف الأصل غير موجود");
      const res = await apiRequest("PATCH", `/api/serialized-items/${trackingData.asset.id}`, {
        serialNumber: editSerial,
        carrierName: editCarrier,
        status: editStatus,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "تم تعديل الأصل بنجاح",
        description: "تم حفظ التعديلات على الرقم التسلسلي والتفاصيل بنجاح",
      });
      setIsEditOpen(false);
      if (editSerial && editSerial !== serialQuery) {
        setSerialQuery(editSerial);
      }
      queryClient.invalidateQueries({ queryKey: [`/api/verification/assets/${serialQuery}`] });
    },
    onError: (err: any) => {
      toast({
        title: "فشل التحديث",
        description: err?.message || "حدث خطأ أثناء حفظ التعديلات",
        variant: "destructive",
      });
    },
  });

  const deleteAssetMutation = useMutation({
    mutationFn: async () => {
      if (!trackingData?.asset?.id) throw new Error("معرّف الأصل غير موجود");
      const res = await apiRequest("DELETE", `/api/serialized-items/${trackingData.asset.id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "تم حذف الأصل نهائياً",
        description: `تم حذف الأصل (${trackingData?.asset?.serialNumber}) بالكامل من النظام والقوائم`,
      });
      setIsDeleteOpen(false);
      handleClear();
    },
    onError: (err: any) => {
      toast({
        title: "فشل حذف الأصل",
        description: err?.message || "حدث خطأ أثناء محاولة حذف الأصل",
        variant: "destructive",
      });
    },
  });
  const queryClient = useQueryClient();
  const [scanValue, setScanValue] = useState("");
  const [serialQuery, setSerialQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [timelineFilter, setTimelineFilter] = useState<string>("ALL");
  const [selectedEvent, setSelectedEvent] = useState<UnifiedAssetTrackingData["timeline"][0] | null>(null);
  const [selectedUserModal, setSelectedUserModal] = useState<{ id: string; name: string; username: string; avatar?: string | null; role?: string } | null>(null);
  const [visibleTimelineCount, setVisibleTimelineCount] = useState(10);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { data: trackingData, error, isLoading, refetch } = useQuery<UnifiedAssetTrackingData>({
    queryKey: [`/api/verification/assets/${serialQuery}`],
    enabled: !!serialQuery,
    retry: false,
  });

  const { data: activeItemTypes = [] } = useActiveItemTypes();

  const resolvedItemTypeId = trackingData?.asset?.itemTypeId || 
    (activeItemTypes || []).find((it: any) => 
      (it.nameAr && trackingData?.asset?.itemTypeName && it.nameAr.trim().toLowerCase() === trackingData.asset.itemTypeName.trim().toLowerCase()) ||
      (it.nameEn && trackingData?.asset?.itemTypeName && it.nameEn.trim().toLowerCase() === trackingData.asset.itemTypeName.trim().toLowerCase())
    )?.id;

  const technicianProductUrl = trackingData?.currentCustodian
    ? resolvedItemTypeId
      ? `/technician-details/${trackingData.currentCustodian.id}/item/${resolvedItemTypeId}`
      : `/technician-details/${trackingData.currentCustodian.id}`
    : null;

  const updateStatusMutation = useMutation({
    mutationFn: async ({ status }: { status: string }) => {
      if (!trackingData?.asset?.id) return;
      const res = await apiRequest("PATCH", `/api/items/${trackingData.asset.id}/status`, {
        status,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "تم تحديث حالة الأصل بنجاح",
        description: "تحديث شريط التتبع وإضافة حركة جديدة بالسجل.",
      });
      queryClient.invalidateQueries({ queryKey: [`/api/verification/assets/${serialQuery}`] });
      refetch();
    },
    onError: (err: any) => {
      toast({
        title: t('verification.fail_update_status'),
        description: err.message || t('verification.error'),
        variant: "destructive",
      });
    },
  });

  const handleSearchSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!scanValue.trim()) return;
    setSerialQuery(scanValue.trim());
    setVisibleTimelineCount(10);
  };

  const handleQuickScan = (sampleSerial: string) => {
    setScanValue(sampleSerial);
    setSerialQuery(sampleSerial);
    setVisibleTimelineCount(10);
  };

  const handleClear = () => {
    setScanValue("");
    setSerialQuery("");
    setSelectedEvent(null);
    inputRef.current?.focus();
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast({
      title: "تم النسخ بنجاح",
      description: text,
    });
    setTimeout(() => setCopied(false), 2000);
  };

  // Status Styling Resolver - RASSCO Enterprise Tokens
  const resolveStatusBadge = (colorKey?: string) => {
    switch (colorKey) {
      case "green":
      case "teal":
        return "rassco-badge-technician shadow-xs";
      case "blue":
        return "rassco-badge-warehouse shadow-xs";
      case "orange":
        return "rassco-badge-transit shadow-xs";
      case "red":
        return "rassco-badge-damaged shadow-xs";
      default:
        return "rassco-badge-closed shadow-xs";
    }
  };

  const formatFullDateTime = (dateStr?: string | null) => {
    if (!dateStr) return "غير متوفر";
    try {
      const d = new Date(dateStr);
      return d.toLocaleString("ar-SA", {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    } catch {
      return dateStr;
    }
  };

  // Filter & Sort Timeline
  const filteredTimeline = (trackingData?.timeline || []).filter((item) => {
    if (timelineFilter === "ALL") return true;
    if (timelineFilter === "CLOSING") return item.eventType === "CLOSING";
    if (timelineFilter === "CUSTODY") return item.eventType === "CUSTODY";
    if (timelineFilter === "INTAKE") return item.eventType === "INTAKE";
    if (timelineFilter === "RETURN") return item.eventType === "RETURN";
    return true;
  }).sort((a, b) => {
    const timeA = new Date(a.occurredAt).getTime();
    const timeB = new Date(b.occurredAt).getTime();
    return sortOrder === "desc" ? timeB - timeA : timeA - timeB;
  });

  const displayedTimeline = filteredTimeline.slice(0, visibleTimelineCount);

  return (
    <div className="verification-page-wrapper space-y-8 font-['Cairo'] pb-20 rassco-bg-page" dir="rtl">
      {/* Top Banner Header - RASSCO Tokens */}
      <header className="relative overflow-hidden rounded-3xl rassco-card-surface border rassco-border-default p-8 shadow-sm">
        <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full rassco-header-badge text-xs font-semibold">
              <Activity className="w-4 h-4 rassco-icon-brand" />
              <span>STOCKPRO — نظام تتبع رحلة الأصل والدورة الحياتية الميدانية</span>
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-3 rassco-text-main">
              <QrCode className="w-8 h-8 rassco-icon-brand" />
              بوابة تتبع ودورة حياة الرقم التسلسلي
            </h1>
            <p className="rassco-text-muted text-sm max-w-2xl leading-relaxed">
              استعلام وتتبع كامل للأجهزة، الباركودات، وشرائح SIM الميدانية مع سجل شفاف يوضح المسند إليه ومسؤول الأكشن والتوقيت بدقة.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link href="/home">
              <Button variant="outline" className="rassco-btn-secondary font-bold rounded-2xl shadow-sm">
                <ArrowRight className="ml-2 h-4 w-4" />
                لوحة التحكم الرئيسية
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content Layout */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Search Panel (4 Columns) - RASSCO Tokens */}
        <Card className="lg:col-span-4 rassco-card-surface border rassco-border-default shadow-sm rounded-3xl overflow-hidden flex flex-col justify-between self-start">
          <div>
            <CardHeader className="rassco-card-header border-b pb-6">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl rassco-header-badge flex items-center justify-center">
                  <QrCode className="w-6 h-6 rassco-icon-brand" />
                </div>
                <div>
                  <CardTitle className="rassco-text-main text-lg font-bold">
                    البحث عن أصل أو شريحة
                  </CardTitle>
                  <CardDescription className="rassco-text-muted text-xs mt-0.5">
                    أدخل السيريال (S/N) أو IMEI أو ICCID أو الباركود
                  </CardDescription>
                </div>
              </div>
            </CardHeader>

            <CardContent className="p-6 space-y-6">
              <form onSubmit={handleSearchSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold rassco-text-main flex items-center justify-between">
                    <span>الرقم التسلسلي المعرف / Asset ID</span>
                    <span className="rassco-text-muted font-normal">تأطير تلقائي للبادئة</span>
                  </label>
                  <div className="relative">
                    <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 h-5 w-5 rassco-icon-brand" />
                    <Input
                      ref={inputRef}
                      value={scanValue}
                      onChange={(e) => setScanValue(e.target.value)}
                      placeholder="مثال: SAW43310018885"
                      className="pr-11 pl-4 h-12 rassco-input-field rounded-2xl font-mono text-center text-base font-bold shadow-xs"
                    />
                  </div>
                </div>

                <div className="flex gap-2 pt-1">
                  <Button 
                    type="submit" 
                    className="flex-1 h-11 rassco-btn-primary font-bold rounded-xl shadow-md transition-all active:scale-[0.98]"
                  >
                    <Search className="w-4 h-4 ml-2" />
                    بدء التتبع
                  </Button>
                  {(scanValue || serialQuery) && (
                    <Button 
                      type="button" 
                      onClick={handleClear} 
                      variant="outline" 
                      className="h-11 px-4 rassco-btn-secondary font-bold rounded-xl"
                    >
                      تفريغ
                    </Button>
                  )}
                </div>
              </form>

              {/* Quick Sample Buttons */}
              <div className="pt-4 border-t rassco-border-default space-y-2.5">
                <p className="text-xs font-bold rassco-text-muted flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 rassco-icon-brand" />
                  <span>نماذج سريعة للاختبار الفوري:</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => handleQuickScan("SAW43310018885")}
                    className="text-xs font-mono px-3 py-1.5 rounded-xl rassco-sample-btn transition-all font-semibold"
                  >
                    i9100: SAW43310018885
                  </button>
                  <button
                    onClick={() => handleQuickScan("SAS30810004647")}
                    className="text-xs font-mono px-3 py-1.5 rounded-xl rassco-sample-btn transition-all font-semibold"
                  >
                    i9000S: SAS30810004647
                  </button>
                  <button
                    onClick={() => handleQuickScan("1180234360")}
                    className="text-xs font-mono px-3 py-1.5 rounded-xl rassco-sample-btn transition-all font-semibold"
                  >
                    A960: 1180234360
                  </button>
                </div>
              </div>
            </CardContent>
          </div>

          <CardFooter className="rassco-card-header border-t p-4 text-xs rassco-text-muted flex items-center gap-2.5">
            <ShieldCheck className="w-4 h-4 rassco-icon-brand shrink-0" />
            <span className="leading-tight">تكامل تلقائي للتدقيق الأمني والصلاحيات الميدانية</span>
          </CardFooter>
        </Card>

        {/* Tracking Results Area (8 Columns) */}
        <div className="lg:col-span-8 space-y-6">
          {/* Skeleton / Loading State */}
          {isLoading && (
            <Card className="rassco-card-surface border rassco-border-default shadow-sm rounded-3xl h-full min-h-[420px] flex items-center justify-center p-12">
              <div className="text-center space-y-4">
                <div className="relative w-16 h-16 mx-auto">
                  <div className="w-16 h-16 border-4 rassco-border-brand border-t-[#00A99D] rounded-full animate-spin" />
                  <QrCode className="w-6 h-6 rassco-icon-brand absolute inset-0 m-auto" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-base font-bold rassco-text-main">جاري تجميع رحلة الأصل والسجل...</h4>
                  <p className="rassco-text-muted text-xs font-mono">{serialQuery}</p>
                </div>
              </div>
            </Card>
          )}

          {/* Initial State */}
          {!serialQuery && !isLoading && (
            <Card className="rassco-card-surface border border-dashed rassco-border-default shadow-sm rounded-3xl h-full min-h-[420px] flex items-center justify-center p-12 text-center">
              <div className="max-w-md space-y-4">
                <div className="w-20 h-20 rounded-3xl rassco-header-badge mx-auto flex items-center justify-center shadow-inner">
                  <QrCode className="w-10 h-10 stroke-[1.5] rassco-icon-brand animate-pulse" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold rassco-text-main">امسح الباركود أو ادخل الرقم التسلسلي</h3>
                  <p className="rassco-text-muted text-sm leading-relaxed">
                    سيتم بناء جدول تتبع زمني حديث يعرض صاحب العهدة الحالي ومسؤول الإغلاق مع كامل حركات السجل التاريخي.
                  </p>
                </div>
              </div>
            </Card>
          )}

          {/* Error State */}
          {error && !isLoading && (
            <Card className="rassco-card-surface border rassco-border-default shadow-sm rounded-3xl h-full min-h-[420px] flex items-center justify-center p-12 text-center">
              <div className="max-w-md space-y-4">
                <div className="w-16 h-16 rounded-full rassco-badge-damaged mx-auto flex items-center justify-center shadow-inner">
                  <AlertCircle className="w-8 h-8" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-xl font-bold rassco-text-main">تعذر العثور على الأصل</h3>
                  <p className="text-rose-600 text-sm font-semibold">{(error as any)?.message || t('verification.error')}</p>
                </div>
                <Button onClick={handleClear} variant="outline" className="rassco-btn-secondary font-bold rounded-xl mt-2">
                  إعادة المحاولة
                </Button>
              </div>
            </Card>
          )}

          {/* Result Loaded */}
          {trackingData && !isLoading && (
            <div className="space-y-6">
              {/* 1. Summary Header Card (بطاقة ملخص رحلة الجهاز) - RASSCO Tokens */}
              <Card className="rassco-card-surface rounded-3xl p-6 md:p-8 border rassco-border-default shadow-sm relative overflow-hidden">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="space-y-2">
                    <div className="flex items-center gap-3">
                      <Badge className={`${resolveStatusBadge(trackingData.asset.statusColor)} text-sm font-extrabold px-3.5 py-1 rounded-xl`}>
                        {trackingData.asset.statusLabel}
                      </Badge>
                      {trackingData.asset.carrierName && (
                        <Badge className="rassco-badge-technician text-xs font-bold">
                          {trackingData.asset.carrierName}
                        </Badge>
                      )}
                    </div>

                    <h2 className="text-2xl font-extrabold rassco-text-main pt-1">
                      {trackingData.asset.itemTypeName}
                    </h2>

                    <div className="flex items-center gap-3 rassco-text-muted text-sm font-mono pt-1">
                      <span>S/N:</span>
                      <span className="rassco-text-main font-bold text-base rassco-sub-surface px-3 py-1 rounded-xl border rassco-border-default">
                        {trackingData.asset.serialNumber}
                      </span>
                      <button
                        onClick={() => copyToClipboard(trackingData.asset.serialNumber)}
                        className="p-1.5 rassco-sample-btn rounded-lg transition-all"
                        title="نسخ الرقم التسلسلي"
                      >
                        {copied ? <Check className="w-4 h-4 rassco-icon-brand" /> : <Copy className="w-4 h-4 rassco-text-muted" />}
                      </button>
                    </div>

                    <div className="pt-2 flex items-center gap-2 flex-wrap">
                      {technicianProductUrl && (
                        <Link href={technicianProductUrl}>
                          <Button
                            variant="outline"
                            className="rassco-btn-secondary font-bold rounded-xl text-xs gap-2 transition-all shadow-sm"
                          >
                            <Boxes className="w-4 h-4 rassco-icon-brand" />
                            <span>عرض تفاصيل المنتج في مخزون الفني</span>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </Button>
                        </Link>
                      )}

                      {isAdminOrSupervisor && trackingData?.asset?.id && (
                        <>
                          <Button
                            onClick={openEditModal}
                            variant="outline"
                            className="rassco-btn-secondary font-bold rounded-xl text-xs gap-1.5 transition-all shadow-sm"
                          >
                            <Pencil className="w-3.5 h-3.5 rassco-icon-brand" />
                            <span>تعديل الأصل</span>
                          </Button>

                          <Button
                            onClick={() => setIsDeleteOpen(true)}
                            variant="outline"
                            className="rassco-btn-danger font-bold rounded-xl text-xs gap-1.5 transition-all shadow-sm"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-white" />
                            <span>حذف الأصل نهائياً</span>
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Summary Metric Badges */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-4 md:pt-0 border-t md:border-t-0 rassco-border-default">
                    <div className="rassco-sub-surface p-3 rounded-2xl border rassco-border-default text-center">
                      <p className="text-[11px] rassco-text-muted font-bold">صاحب العهدة</p>
                      <p className="text-xs font-bold rassco-text-main truncate mt-0.5">{trackingData.summary.custodianName}</p>
                    </div>

                    <div className="rassco-sub-surface p-3 rounded-2xl border rassco-border-default text-center">
                      <p className="text-[11px] rassco-text-muted font-bold">الموقع والحركة</p>
                      <p className="text-xs font-bold rassco-text-main truncate mt-0.5">{trackingData.summary.locationName}</p>
                    </div>

                    <div className="rassco-sub-surface p-3 rounded-2xl border rassco-border-default text-center col-span-2 sm:col-span-1">
                      <p className="text-[11px] rassco-text-muted font-bold">إجمالي الحركات</p>
                      <p className="text-xs font-bold rassco-text-brand mt-0.5">{trackingData.summary.totalMovements} حركات مسجلة</p>
                    </div>
                  </div>
                </div>
              </Card>

              {/* 2. Current Custodian Card (بطاقة صاحب العهدة الحالي) - RASSCO Tokens */}
              {trackingData.currentCustodian && (
                <Card className="rassco-card-surface border rassco-border-default shadow-sm rounded-3xl overflow-hidden">
                  <CardHeader className="rassco-card-header border-b p-5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-extrabold rassco-text-main flex items-center gap-2">
                        <UserCheck className="w-5 h-5 rassco-icon-brand" />
                        <span>بيانات صاحب العهدة الحالي</span>
                      </h3>
                      <div className="flex items-center gap-3">
                        {technicianProductUrl && (
                          <Link href={technicianProductUrl}>
                            <Button
                              variant="outline"
                              size="sm"
                              className="rassco-btn-secondary font-bold rounded-xl text-xs gap-1.5 shadow-2xs"
                            >
                              <Boxes className="w-3.5 h-3.5 rassco-icon-brand" />
                              <span>تفاصيل المنتج في العهدة</span>
                              <ExternalLink className="w-3 h-3" />
                            </Button>
                          </Link>
                        )}
                        <button
                          onClick={() => setSelectedUserModal({
                            id: trackingData.currentCustodian!.id,
                            name: trackingData.currentCustodian!.fullName,
                            username: trackingData.currentCustodian!.username,
                            avatar: trackingData.currentCustodian!.avatarUrl,
                            role: "فني ميداني",
                          })}
                          className="text-xs font-bold rassco-text-brand hover:underline flex items-center gap-1"
                        >
                          <span>عرض الملف الكامل</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="p-6 space-y-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 rassco-sub-surface p-4 rounded-2xl border rassco-border-default">
                      <Avatar className="h-16 w-16 border-2 rassco-border-brand shrink-0 shadow-md">
                        <AvatarImage src={trackingData.currentCustodian.avatarUrl || undefined} alt={trackingData.currentCustodian.fullName} />
                        <AvatarFallback className="rassco-btn-primary font-bold text-lg">
                          {trackingData.currentCustodian.fullName.slice(0, 2)}
                        </AvatarFallback>
                      </Avatar>

                      <div className="space-y-1 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="text-lg font-extrabold rassco-text-main">{trackingData.currentCustodian.fullName}</h4>
                          <Badge className="rassco-badge-technician text-xs">
                            {trackingData.currentCustodian.jobTitle}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-xs rassco-text-muted flex-wrap">
                          <span className="font-mono rassco-text-brand font-bold flex items-center gap-1">
                            <AtSign className="w-3 h-3 rassco-icon-brand" />
                            {trackingData.currentCustodian.username}
                          </span>
                          {trackingData.currentCustodian.employeeCode && (
                            <span className="rassco-card-surface px-2 py-0.5 rounded border rassco-border-default font-mono">
                              كود: {trackingData.currentCustodian.employeeCode}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Call & WhatsApp actions */}
                      {trackingData.currentCustodian.phone && (
                        <div className="flex items-center gap-2 self-stretch sm:self-auto justify-end pt-2 sm:pt-0 border-t sm:border-t-0 rassco-border-default">
                          <a
                            href={`tel:${trackingData.currentCustodian.phone}`}
                            className="p-2.5 rassco-btn-secondary rounded-xl shadow-2xs transition-all flex items-center gap-1 text-xs font-bold"
                            title="اتصال تلفوني"
                          >
                            <Phone className="w-4 h-4 rassco-icon-brand" />
                            <span>اتصال</span>
                          </a>
                          <a
                            href={`https://wa.me/${trackingData.currentCustodian.phone.replace(/[^0-9]/g, '')}`}
                            target="_blank"
                            rel="noreferrer"
                            className="p-2.5 rassco-btn-success rounded-xl shadow-2xs transition-all flex items-center gap-1 text-xs font-bold"
                            title="مراسلة واتساب"
                          >
                            <MessageCircle className="w-4 h-4 text-white" />
                            <span>واتساب</span>
                          </a>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div className="rassco-sub-surface p-3 rounded-xl border rassco-border-default">
                        <p className="rassco-text-muted font-bold">المنطقة والمدينة</p>
                        <p className="rassco-text-main font-bold mt-0.5">{trackingData.currentCustodian.regionName} — {trackingData.currentCustodian.city}</p>
                      </div>

                      <div className="rassco-sub-surface p-3 rounded-xl border rassco-border-default">
                        <p className="rassco-text-muted font-bold">المستودع التابع له</p>
                        <p className="rassco-text-main font-bold mt-0.5">{trackingData.currentCustodian.warehouseName}</p>
                      </div>

                      <div className="rassco-sub-surface p-3 rounded-xl border rassco-border-default">
                        <p className="rassco-text-muted font-bold">تاريخ الاستلام</p>
                        <p className="rassco-text-main font-mono font-bold mt-0.5">{formatFullDateTime(trackingData.currentCustodian.receivedAt)}</p>
                      </div>

                      <div className="rassco-sub-surface p-3 rounded-xl border rassco-border-default">
                        <p className="rassco-text-muted font-bold">مدة وجود العهدة</p>
                        <p className="rassco-text-brand font-extrabold mt-0.5">{trackingData.currentCustodian.custodyDurationDays} أيام متواصلة</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* 3. Last Action Responsible Card (بطاقة المسؤول عن آخر إجراء) - RASSCO Tokens */}
              {trackingData.lastActionBy && (
                <Card className="rassco-card-surface border rassco-border-default shadow-sm rounded-3xl overflow-hidden">
                  <CardHeader className="rassco-card-header border-b p-5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-extrabold rassco-text-main flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 rassco-icon-brand" />
                        <span>المسؤول عن آخر إجراء</span>
                      </h3>
                      <Badge variant="outline" className="rassco-card-surface rassco-text-main border rassco-border-default text-xs font-mono font-bold">
                        {trackingData.lastActionBy.actionNumber}
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="p-6 space-y-4">
                    <div className="flex items-center gap-4 rassco-sub-surface p-4 rounded-2xl border rassco-border-default">
                      <Avatar className="h-14 w-14 border-2 rassco-border-brand shrink-0">
                        <AvatarImage src={trackingData.lastActionBy.avatarUrl || undefined} alt={trackingData.lastActionBy.fullName} />
                        <AvatarFallback className="rassco-btn-primary font-bold">
                          {trackingData.lastActionBy.fullName.slice(0, 2)}
                        </AvatarFallback>
                      </Avatar>

                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h4 className="text-base font-extrabold rassco-text-main truncate">{trackingData.lastActionBy.fullName}</h4>
                          <Badge className="rassco-badge-technician text-xs">
                            {trackingData.lastActionBy.roleLabel}
                          </Badge>
                        </div>
                        <p className="text-xs font-mono rassco-text-brand font-bold flex items-center gap-1">
                          <AtSign className="w-3 h-3 rassco-icon-brand" />
                          {trackingData.lastActionBy.username}
                        </p>
                      </div>

                      <div className="text-left shrink-0">
                        <p className="text-xs font-mono font-bold rassco-text-main">{formatFullDateTime(trackingData.lastActionBy.occurredAt)}</p>
                        <p className="text-[11px] rassco-text-muted mt-0.5">{trackingData.lastActionBy.regionName}</p>
                      </div>
                    </div>

                    {trackingData.lastActionBy.notes && (
                      <div className="p-3 rassco-sub-surface border rassco-border-default rounded-xl text-xs rassco-text-main italic">
                        ملاحظات العملية: {trackingData.lastActionBy.notes}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* 4. Closure Details Card (بطاقة بيانات الإغلاق) - RASSCO Tokens */}
              {trackingData.closure?.isClosed && (
                <Card className="rassco-card-surface border rassco-border-default shadow-sm rounded-3xl overflow-hidden">
                  <CardHeader className="rassco-card-header border-b p-5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-extrabold rassco-text-main flex items-center gap-2">
                        <FileCheck className="w-5 h-5 text-[#10B981]" />
                        <span>بيانات وتوثيق الإغلاق النهائي</span>
                      </h3>
                      <Badge className="rassco-btn-success text-white font-extrabold px-3 py-1 text-xs">
                        عملية مكتملة ومغلقة
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="p-6 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                      <div className="rassco-sub-surface p-3.5 rounded-xl border rassco-border-default space-y-1">
                        <p className="rassco-text-muted font-bold">تاريخ وساعة الإغلاق</p>
                        <p className="rassco-text-main font-mono font-extrabold">{formatFullDateTime(trackingData.closure.closedAt)}</p>
                      </div>

                      <div className="rassco-sub-surface p-3.5 rounded-xl border rassco-border-default space-y-1">
                        <p className="rassco-text-muted font-bold">المسؤول عن الإغلاق</p>
                        <p className="rassco-text-main font-bold">{trackingData.closure.closedByName} (@{trackingData.closure.closedByUsername})</p>
                      </div>

                      <div className="rassco-sub-surface p-3.5 rounded-xl border rassco-border-default space-y-1">
                        <p className="rassco-text-muted font-bold">رقم الطلب والعميل</p>
                        <p className="rassco-text-brand font-mono font-extrabold">{trackingData.closure.orderNumber} — {trackingData.closure.clientName}</p>
                      </div>
                    </div>

                    {trackingData.closure.notes && (
                      <div className="p-3 rassco-sub-surface border rassco-border-default rounded-xl text-xs rassco-text-main">
                        <span className="font-bold rassco-text-brand">ملاحظات التوثيق: </span>
                        {trackingData.closure.notes}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* 5. Linked Identifiers (الأصول المرتبطة) - RASSCO Tokens */}
              {trackingData.linkedIdentifiers.length > 0 && (
                <Card className="rassco-card-surface border rassco-border-default shadow-sm rounded-3xl overflow-hidden">
                  <CardHeader className="rassco-card-header border-b p-5">
                    <h3 className="text-base font-extrabold rassco-text-main flex items-center gap-2">
                      <Handshake className="w-5 h-5 rassco-icon-brand" />
                      <span>الأصول وشرائح الاتصالات المرتبطة</span>
                    </h3>
                  </CardHeader>
                  <CardContent className="p-6 space-y-3">
                    {trackingData.linkedIdentifiers.map((link, idx) => (
                      <div key={idx} className="flex items-center justify-between rassco-sub-surface p-4 rounded-2xl border rassco-border-default">
                        <div className="space-y-1">
                          <p className="text-xs font-bold rassco-text-muted">{link.type} ({link.carrierName})</p>
                          <p className="text-sm font-mono font-extrabold rassco-text-main">{link.serialNumber}</p>
                        </div>
                        <Button
                          onClick={() => handleQuickScan(link.serialNumber)}
                          variant="outline"
                          className="rassco-btn-secondary text-xs font-bold rounded-xl"
                        >
                          تتبع الشريحة
                        </Button>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* 6. Advanced Shipment-Style Audit Timeline (التسلسل الزمني الحديث) - RASSCO Tokens */}
              <Card className="rassco-card-surface border rassco-border-default shadow-sm rounded-3xl overflow-hidden">
                <CardHeader className="rassco-card-header border-b p-6">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <CardTitle className="text-lg font-bold rassco-text-main flex items-center gap-2">
                        <GitCommit className="w-5 h-5 rassco-icon-brand" />
                        <span>رحلة الأصل والتسلسل الزمني للعمليات</span>
                      </CardTitle>
                      <CardDescription className="text-xs rassco-text-muted mt-1">
                        انقر على أي حدث لعرض التوثيق الفني الكامل والأجهزة ومصدر الأكشن
                      </CardDescription>
                    </div>

                    {/* Filter and Sort Controls */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        onClick={() => setSortOrder(sortOrder === "desc" ? "asc" : "desc")}
                        variant="outline"
                        className="h-9 text-xs font-bold rassco-btn-secondary rounded-xl flex items-center gap-1.5"
                      >
                        <ArrowUpDown className="w-3.5 h-3.5" />
                        <span>{sortOrder === "desc" ? "الأحدث أولاً" : "الأقدم أولاً"}</span>
                      </Button>

                      <div className="flex items-center rassco-sub-surface p-1 rounded-xl border rassco-border-default text-xs font-bold">
                        <button
                          onClick={() => setTimelineFilter("ALL")}
                          className={`px-2.5 py-1 rounded-lg transition-all ${timelineFilter === "ALL" ? "rassco-card-surface rassco-text-main shadow-2xs" : "rassco-text-muted"}`}
                        >
                          الكل
                        </button>
                        <button
                          onClick={() => setTimelineFilter("CUSTODY")}
                          className={`px-2.5 py-1 rounded-lg transition-all ${timelineFilter === "CUSTODY" ? "rassco-card-surface rassco-text-brand shadow-2xs" : "rassco-text-muted"}`}
                        >
                          العهدة
                        </button>
                        <button
                          onClick={() => setTimelineFilter("CLOSING")}
                          className={`px-2.5 py-1 rounded-lg transition-all ${timelineFilter === "CLOSING" ? "rassco-card-surface text-[#10B981] shadow-2xs" : "rassco-text-muted"}`}
                        >
                          الإغلاق
                        </button>
                      </div>
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="p-6 md:p-8">
                  <div className="relative pr-6 border-r-2 rassco-border-brand space-y-8">
                    {displayedTimeline.map((item, index) => {
                      const isLatest = index === 0 && sortOrder === "desc";

                      return (
                        <div
                          key={item.eventId}
                          onClick={() => setSelectedEvent(item)}
                          className={`relative group rassco-sub-surface hover:rassco-card-header p-5 rounded-2xl border transition-all cursor-pointer shadow-2xs hover:shadow-md ${
                            isLatest ? "rassco-border-brand ring-2 ring-[#00A99D]/20" : "rassco-border-default hover:rassco-border-brand"
                          }`}
                        >
                          {/* Circle on line */}
                          <div className={`absolute -right-[31px] top-6 w-4 h-4 rounded-full border-2 border-white ring-4 transition-all ${
                            isLatest ? "bg-[#00A99D] ring-[#00A99D]/30 animate-pulse" : "bg-slate-400 ring-slate-200 group-hover:bg-[#00A99D]"
                          }`} />

                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="space-y-2">
                              <div className="flex items-center gap-2.5 flex-wrap">
                                <Badge className={`${resolveStatusBadge(item.statusColor)} text-xs font-bold px-2.5 py-0.5`}>
                                  {item.statusToLabel}
                                </Badge>
                                <span className="text-xs font-extrabold rassco-text-main">{item.title}</span>
                              </div>

                              <div className="flex items-center gap-2 text-xs rassco-text-muted flex-wrap">
                                <div className="flex items-center gap-1.5 font-bold rassco-text-main">
                                  <Avatar className="h-5 w-5 border rassco-border-default">
                                    <AvatarImage src={item.actor.avatarUrl || undefined} />
                                    <AvatarFallback className="rassco-btn-primary text-white text-[9px]">
                                      {item.actor.name.slice(0, 1)}
                                    </AvatarFallback>
                                  </Avatar>
                                  <span>{item.actor.name}</span>
                                  <span className="text-[11px] font-mono rassco-text-muted">(@{item.actor.username})</span>
                                </div>
                                <span>•</span>
                                <span className="rassco-text-muted">{item.location?.name || "المستودع الرئيسي"}</span>
                              </div>

                              {item.description && (
                                <p className="text-xs rassco-text-muted italic">
                                  {item.description}
                                </p>
                              )}
                            </div>

                            <div className="text-left shrink-0 space-y-1">
                              <p className="text-xs font-mono font-bold rassco-text-brand flex items-center justify-end gap-1">
                                <Clock className="w-3.5 h-3.5 rassco-icon-brand" />
                                <span>{formatFullDateTime(item.occurredAt)}</span>
                              </p>
                              <span className="text-[11px] font-bold rassco-text-brand group-hover:underline flex items-center justify-end gap-1">
                                <span>التفاصيل الكاملة</span>
                                <ChevronLeft className="w-3.5 h-3.5" />
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Load More Button */}
                  {filteredTimeline.length > visibleTimelineCount && (
                    <div className="pt-6 text-center">
                      <Button
                        onClick={() => setVisibleTimelineCount((prev) => prev + 10)}
                        variant="outline"
                        className="rassco-btn-secondary font-bold rounded-xl px-8"
                      >
                        عرض باقي الأحداث ({filteredTimeline.length - visibleTimelineCount} متبقية)
                      </Button>
                    </div>
                  )}
                </CardContent>

                <CardFooter className="rassco-card-header border-t p-6 flex flex-col sm:flex-row gap-3">
                  {trackingData.asset.status === "RECEIVED_BY_TECHNICIAN" ? (
                    <Button
                      onClick={() => updateStatusMutation.mutate({ status: "DELIVERED" })}
                      disabled={updateStatusMutation.isPending}
                      className="flex-1 h-12 rassco-btn-primary font-extrabold text-base rounded-xl shadow-md"
                    >
                      تغيير الحالة إلى: اعتماد تسليم الجهاز للعميل وإغلاق الطلب
                    </Button>
                  ) : trackingData.asset.status === "DELIVERED" ? (
                    <Button
                      onClick={() => updateStatusMutation.mutate({ status: "RECEIVED_BY_TECHNICIAN" })}
                      disabled={updateStatusMutation.isPending}
                      className="flex-1 h-12 rassco-btn-secondary font-extrabold text-base rounded-xl shadow-md"
                    >
                      تغيير الحالة إلى: إرجاع لعهدة الفني النشطة
                    </Button>
                  ) : null}
                </CardFooter>
              </Card>
            </div>
          )}
        </div>
      </section>

      {/* Event Details Dialog (كل حدث قابل للنقر) */}
      <Dialog open={!!selectedEvent} onOpenChange={() => setSelectedEvent(null)}>
        <DialogContent className="sm:max-w-xl font-['Cairo'] rounded-3xl" dir="rtl">
          {selectedEvent && (
            <>
              <DialogHeader className="border-b pb-4">
                <DialogTitle className="text-xl font-bold flex items-center gap-2">
                  <Info className="w-5 h-5 text-teal-600" />
                  <span>تفاصيل الحركة والأكشن</span>
                </DialogTitle>
                <DialogDescription className="text-xs text-slate-500">
                  التوثيق الكامل للعملية والجهاز والمنفذ والموقع الجغرافي
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2 text-xs">
                {/* User info */}
                <div className="flex items-center gap-3 bg-slate-50 p-3.5 rounded-2xl border border-slate-200">
                  <Avatar className="h-12 w-12 border-2 border-teal-600">
                    <AvatarImage src={selectedEvent.actor.avatarUrl || undefined} />
                    <AvatarFallback className="bg-teal-700 text-white font-bold">
                      {selectedEvent.actor.name.slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="text-xs font-bold text-slate-400">المنفذ للعملية</p>
                    <p className="text-sm font-extrabold text-slate-900">{selectedEvent.actor.name}</p>
                    <p className="text-xs font-mono text-teal-700">@{selectedEvent.actor.username} ({selectedEvent.actor.role})</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                    <p className="text-slate-400 font-bold">الحالة السابقة</p>
                    <p className="text-slate-900 font-bold mt-0.5">{selectedEvent.statusFromLabel}</p>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                    <p className="text-slate-400 font-bold">الحالة الجديدة</p>
                    <p className="text-teal-700 font-extrabold mt-0.5">{selectedEvent.statusToLabel}</p>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                    <p className="text-slate-400 font-bold">توقيت العملية</p>
                    <p className="text-slate-900 font-mono font-bold mt-0.5">{formatFullDateTime(selectedEvent.occurredAt)}</p>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                    <p className="text-slate-400 font-bold">رقم العملية / Reference</p>
                    <p className="text-cyan-800 font-mono font-bold mt-0.5">{selectedEvent.referenceId || selectedEvent.eventId.slice(0, 12)}</p>
                  </div>
                </div>

                {selectedEvent.notes && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                    <p className="font-bold text-amber-900">الملاحظات والوصف:</p>
                    <p className="text-slate-700 mt-0.5">{selectedEvent.notes}</p>
                  </div>
                )}

                {selectedEvent.metadata && (
                  <div className="p-3 bg-slate-900 text-slate-200 rounded-xl space-y-1 font-mono text-[11px]">
                    <p className="text-teal-400 font-bold">معلومات النظام (System Metadata):</p>
                    <p>المصدر: {selectedEvent.metadata.source || "Web Portal"}</p>
                    <p>رقم الدفعة: {selectedEvent.metadata.actionNumber || "N/A"}</p>
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button onClick={() => setSelectedEvent(null)} className="w-full font-bold rounded-xl">
                  إغلاق Window
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Quick User Details Modal (عند النقر على الشخص) */}
      <Dialog open={!!selectedUserModal} onOpenChange={() => setSelectedUserModal(null)}>
        <DialogContent className="sm:max-w-md font-['Cairo'] rounded-3xl" dir="rtl">
          {selectedUserModal && (
            <>
              <DialogHeader className="border-b pb-4">
                <DialogTitle className="text-lg font-bold">ملف المستخدم</DialogTitle>
              </DialogHeader>

              <div className="py-4 text-center space-y-3">
                <Avatar className="h-20 w-20 mx-auto border-4 border-teal-600 shadow-md">
                  <AvatarImage src={selectedUserModal.avatar || undefined} />
                  <AvatarFallback className="bg-teal-700 text-white font-bold text-2xl">
                    {selectedUserModal.name.slice(0, 2)}
                  </AvatarFallback>
                </Avatar>

                <h3 className="text-xl font-extrabold text-slate-900">{selectedUserModal.name}</h3>
                <p className="text-xs font-mono text-teal-700">@{selectedUserModal.username}</p>
                <Badge className="bg-teal-100 text-teal-900">{selectedUserModal.role || "عضو فريق الميدان"}</Badge>
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row">
                {trackingData?.asset?.itemTypeId && selectedUserModal && (
                  <Link href={`/technician-details/${selectedUserModal.id}/item/${trackingData.asset.itemTypeId}`} className="w-full">
                    <Button variant="outline" className="w-full font-bold rounded-xl border-teal-600 text-teal-700 hover:bg-teal-50 flex items-center justify-center gap-2">
                      <Boxes className="w-4 h-4 text-teal-600" />
                      <span>تفاصيل المنتج المعروض لدى الفني</span>
                    </Button>
                  </Link>
                )}
                <Link href={`/technician-details/${selectedUserModal.id}`} className="w-full">
                  <Button className="w-full font-bold rounded-xl bg-teal-600 hover:bg-teal-700 text-white">
                    الانتقال لصفحة الفني الكاملة
                  </Button>
                </Link>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Asset Dialog */}
      <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
        <DialogContent className="sm:max-w-[480px] bg-white rounded-3xl p-6 border border-slate-200 shadow-2xl font-['Cairo']" dir="rtl">
          <DialogHeader className="text-right pb-2 border-b">
            <DialogTitle className="text-xl font-bold text-slate-900 flex items-center gap-2">
              <Pencil className="w-5 h-5 text-amber-600" />
              <span>تعديل بيانات الأصل ({trackingData?.asset?.serialNumber})</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500 pt-1">
              قم بتحديث الرقم التسلسلي أو مشغل الشريحة أو حالة الأصل بكتالوج العهدة.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4 text-right">
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-700">الرقم التسلسلي (S/N):</label>
              <Input
                value={editSerial}
                onChange={(e) => setEditSerial(e.target.value)}
                placeholder="الرقم التسلسلي"
                className="font-mono rounded-xl border-slate-300 text-left dir-ltr"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-700">المزود / مشغل الشريحة:</label>
              <Input
                value={editCarrier}
                onChange={(e) => setEditCarrier(e.target.value)}
                placeholder="مثال: STC, Mobily, Zain"
                className="rounded-xl border-slate-300"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-700">حالة الأصل الحالية:</label>
              <Select value={editStatus} onValueChange={setEditStatus}>
                <SelectTrigger className="rounded-xl border-slate-300">
                  <SelectValue placeholder="اختر الحالة" />
                </SelectTrigger>
                <SelectContent dir="rtl">
                  <SelectItem value="IN_WAREHOUSE">داخل المستودع (IN_WAREHOUSE)</SelectItem>
                  <SelectItem value="RECEIVED_BY_TECHNICIAN">في عهدة الفني (RECEIVED_BY_TECHNICIAN)</SelectItem>
                  <SelectItem value="IN_TRANSIT_CUSTODY">في طريق النقل الفني (IN_TRANSIT_CUSTODY)</SelectItem>
                  <SelectItem value="INSTALLED">مكتمل ومثبت لدى العميل (INSTALLED)</SelectItem>
                  <SelectItem value="DELIVERED">مستلم ومغلق (DELIVERED)</SelectItem>
                  <SelectItem value="DAMAGED">تالف (DAMAGED)</SelectItem>
                  <SelectItem value="LOST">مفقود (LOST)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2 border-t">
            <Button
              variant="outline"
              onClick={() => setIsEditOpen(false)}
              className="rounded-xl border-slate-200"
            >
              إلغاء
            </Button>
            <Button
              onClick={() => updateAssetMutation.mutate()}
              disabled={updateAssetMutation.isPending}
              className="bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl gap-2"
            >
              {updateAssetMutation.isPending ? "جاري الحفظ..." : "حفظ التعديلات"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Asset Alert Dialog */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent className="bg-white rounded-3xl p-6 border border-rose-200 shadow-2xl font-['Cairo']" dir="rtl">
          <AlertDialogHeader className="text-right">
            <AlertDialogTitle className="text-xl font-bold text-rose-700 flex items-center gap-2">
              <AlertCircle className="w-6 h-6 text-rose-600" />
              <span>تأكيد حذف الأصل نهائياً</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-slate-600 text-sm leading-relaxed pt-2">
              هل أنت تأكد من رغبتك في حذف الأصل (<strong className="font-mono text-slate-900">{trackingData?.asset?.serialNumber}</strong> - {trackingData?.asset?.itemTypeName}) نهائياً من قاعدة البيانات والسجلات؟
              <br />
              <strong className="text-rose-600 font-bold block pt-2">تحذير: هذا الإجراء يحذف الأصل بالكامل من النظام ولن يمكن التراجع عنه.</strong>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0 pt-4 border-t">
            <AlertDialogCancel className="rounded-xl border-slate-200">إلغاء الإجراء</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteAssetMutation.mutate()}
              disabled={deleteAssetMutation.isPending}
              className="bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl"
            >
              {deleteAssetMutation.isPending ? "جاري الحذف..." : "نعم، احذف الأصل نهائياً"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
