import React, { useState, useEffect, useRef } from 'react';
import {
  Scan,
  CheckCircle2,
  AlertCircle,
  XCircle,
  RefreshCw,
  Layers,
  Trash2,
  Barcode,
  Check,
  ShieldCheck,
  ChevronRight,
  Lock,
  PackageCheck,
  Loader2,
} from 'lucide-react';
import { api } from '../api/client';
import { ItemProductAvatar, getItemMetadata } from '../components/ItemProductAvatar';

interface ShipmentScanPageProps {
  transferId: string | null;
  onBack: () => void;
}

const FINALIZED_STATUSES = new Set(['APPROVED', 'COMPLETED', 'REJECTED']);

export const ShipmentScanPage: React.FC<ShipmentScanPageProps> = ({ transferId, onBack }) => {
  const [transfer, setTransfer] = useState<any>(null);
  const [itemTypeInfo, setItemTypeInfo] = useState<{ requiresSerial: boolean; category: string; nameAr?: string; nameEn?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const [serialInput, setSerialInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scannedItems, setScannedItems] = useState<Array<{ serial: string; timestamp: string }>>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [lastScanned, setLastScanned] = useState<{ serial: string; timestamp: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [removingSerial, setRemovingSerial] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (transferId) {
      loadTransferDetails();
    } else {
      setLoading(false);
    }
  }, [transferId]);

  // Keep auto-focus on scanner input
  useEffect(() => {
    const focusTimer = setTimeout(() => {
      inputRef.current?.focus();
    }, 100);
    return () => clearTimeout(focusTimer);
  }, [scannedItems, errorMsg, successMsg]);

  const loadTransferDetails = async () => {
    setLoading(true);
    const data = await api.getTransferById(transferId!);
    setTransfer(data);

    // ROOT FIX: whether an item type requires per-serial scanning must come from
    // the real item_types.requiresSerial column, not a hardcoded frontend list —
    // item types created via the admin panel get an auto-generated UUID id (e.g.
    // Lebara SIM), which can never match a static string list. This was
    // confirmed live: such a SIM transfer showed no scanner UI at all.
    if (data?.itemType) {
      const allTypes = await api.getItemTypes();
      const match = allTypes.find((t: any) => t.id === data.itemType);
      setItemTypeInfo(match ? {
        requiresSerial: !!match.requiresSerial,
        category: match.category,
        nameAr: match.nameAr,
        nameEn: match.nameEn,
      } : null);
    } else {
      setItemTypeInfo(null);
    }

    setLoading(false);
  };

  // ROOT FIX: `transfer` is sourced from the transfers LIST endpoint (there is
  // no dedicated GET /api/warehouse-transfers/:id — client.ts falls back to
  // searching the list), whose `status` field has always collapsed the real
  // DB status 'approved' down to 'accepted' for admin-portal backward-compat.
  // Using `rawStatus` (the true, un-collapsed status) here is required so a
  // genuinely completed transfer is correctly recognized as finalized instead
  // of falling into the "still open" scan flow.
  const status = ((transfer?.rawStatus ?? transfer?.status) || '').toUpperCase();
  const isPending = status === 'PENDING';
  const isFinalized = FINALIZED_STATUSES.has(status);
  const isSerialized = itemTypeInfo?.requiresSerial ?? false;
  const totalRequired: number | null = transfer ? (transfer.quantity || 1) : null;
  const progressPercent = totalRequired ? Math.min(100, Math.round((scannedItems.length / totalRequired) * 100)) : 0;
  const meta = {
    ...getItemMetadata(transfer?.itemType || 'A960'),
    name: itemTypeInfo?.nameAr || itemTypeInfo?.nameEn || getItemMetadata(transfer?.itemType || 'A960').name,
  };
  const custodyItemType: 'DEVICE' | 'SIM' = (itemTypeInfo?.category || getItemMetadata(transfer?.itemType || '').category) === 'sim' ? 'SIM' : 'DEVICE';

  const handleAcceptTransfer = async () => {
    if (!transferId) return;
    setAccepting(true);
    setAcceptError(null);
    const res = await api.acceptTransfer(transferId);
    setAccepting(false);
    if (res.success) {
      await loadTransferDetails();
    } else {
      setAcceptError(res.message || 'فشل قبول الشحنة. يرجى إعادة المحاولة.');
    }
  };

  const handleScanSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!transferId || scanning) return;

    const raw = serialInput.trim().toUpperCase();
    if (!raw) {
      setErrorMsg('⚠️ الرجاء قراءة أو إدخال الرقم التسلسلي للسكانر');
      setSuccessMsg(null);
      return;
    }

    // Sanitize Barcode prefixes
    let cleanSerial = raw;
    if (cleanSerial.startsWith(']C1')) cleanSerial = cleanSerial.substring(3);
    else if (cleanSerial.startsWith('C1')) cleanSerial = cleanSerial.substring(2);

    // Client-side quick duplicate check (server also enforces this)
    if (scannedItems.some((i) => i.serial === cleanSerial)) {
      setErrorMsg(`⚠️ الرقم التسلسلي (${cleanSerial}) مضاف بالفعل في جدول القراءة!`);
      setSuccessMsg(null);
      setSerialInput('');
      return;
    }

    setScanning(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const res = await api.scanTransferSerial(transferId, cleanSerial);

    setScanning(false);

    if (!res.success) {
      setErrorMsg(`⚠️ ${res.message || 'تعذر مسح واعتماد هذا الرقم التسلسلي'}`);
      setSerialInput('');
      return;
    }

    const nowStr = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    setScannedItems((prev) => [{ serial: cleanSerial, timestamp: nowStr }, ...prev]);
    setLastScanned({ serial: cleanSerial, timestamp: nowStr });
    setSuccessMsg(`✓ تم مسح واستلام الرقم التسلسلي [${cleanSerial}] في نظام السيرفر بنجاح`);
    setSerialInput('');
  };

  // Undoing a scan actually removes the item from the technician's real custody
  // server-side (not just a local list edit) — keeps documentation consistent.
  const removeItem = async (serial: string) => {
    setRemovingSerial(serial);
    const res = await api.deleteCustodyItem(custodyItemType, serial, serial, 'تصحيح خطأ مسح فوري');
    setRemovingSerial(null);
    if (res.success) {
      setScannedItems((prev) => prev.filter((i) => i.serial !== serial));
    } else {
      setErrorMsg(`⚠️ تعذر التراجع عن مسح (${serial}): ${res.message || ''}`);
    }
  };

  const handleFinalConfirm = async () => {
    if (!transferId) return;

    if (isSerialized && totalRequired && scannedItems.length < totalRequired) {
      setErrorMsg(`⚠️ يجب مسح ${totalRequired} قطعة قبل الاعتماد النهائي (تم مسح ${scannedItems.length} فقط)`);
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    const res = await api.confirmTransferReceipt(transferId);

    setIsSubmitting(false);

    if (res.success) {
      setSuccessMsg(`🎉 ${res.message || 'تم تأكيد استلام الشحنة وتحديث المخزون بنجاح'}`);
      setTimeout(() => {
        onBack();
      }, 2000);
    } else {
      setErrorMsg(res.message || 'فشل تأكيد الاستلام النهائي بالسيرفر. يرجى إعادة المحاولة.');
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-slate-400 space-y-4">
        <RefreshCw className="w-8 h-8 animate-spin text-[#0F5EA8]" />
        <p className="text-sm font-extrabold text-slate-700">جاري تحميل بيانات محطة المسح والمطابقة...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Top Breadcrumb Header & Return Button */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-xs font-black hover:bg-slate-50 transition-all cursor-pointer shadow-2xs"
        >
          <ChevronRight className="w-4 h-4 text-[#0F5EA8]" />
          <span>العودة لجدول التحويلات الرئيسية</span>
        </button>

        <div className="hidden sm:flex items-center gap-2 text-xs font-extrabold text-slate-500">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span>جلسة مطابقة آمنة ومشفّرة</span>
        </div>
      </div>

      {/* No Transfer Selected — scanning always requires a real shipment now */}
      {!transferId && (
        <div className="bg-white rounded-3xl p-10 border border-slate-200 shadow-2xs text-center space-y-3">
          <Barcode className="w-12 h-12 text-slate-300 mx-auto" />
          <h3 className="text-sm font-black text-slate-700">لم يتم تحديد شحنة للمسح</h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            الاستلام والتوثيق الصحيح يتطلبان فتح المسح من شحنة فعلية عبر جدول التحويلات، حتى يتم التحقق من نوع الصنف والكمية المطلوبة تلقائيًا من السيرفر.
          </p>
          <button
            onClick={onBack}
            className="mt-2 px-6 py-2.5 rounded-2xl bg-[#0F5EA8] text-white text-xs font-black hover:opacity-90 transition-all cursor-pointer"
          >
            الذهاب لجدول التحويلات
          </button>
        </div>
      )}

      {/* Transfer Failed To Load */}
      {transferId && !loading && !transfer && (
        <div className="bg-white rounded-3xl p-10 border border-slate-200 shadow-2xs text-center space-y-3">
          <XCircle className="w-12 h-12 text-rose-300 mx-auto" />
          <h3 className="text-sm font-black text-slate-700">تعذر تحميل بيانات هذه الشحنة</h3>
          <p className="text-xs text-slate-400">رقم الشحنة غير صالح أو غير متاح لحسابك. الرجاء العودة والمحاولة من جدول التحويلات.</p>
        </div>
      )}

      {/* Transfer loaded */}
      {transfer && (
        <>
          {/* Gate: Must accept the transfer before any scanning can start */}
          {isPending && (
            <div className="bg-white rounded-3xl p-6 sm:p-8 border-2 border-amber-200 shadow-2xs space-y-5">
              <div className="flex flex-col sm:flex-row items-center gap-5 text-center sm:text-right">
                <ItemProductAvatar
                  itemTypeKey={transfer.itemType || 'A960'}
                  displayName={itemTypeInfo?.nameAr || itemTypeInfo?.nameEn}
                  displayCategory={itemTypeInfo?.category as any}
                  size="lg"
                  showCategoryPill={true}
                />
                <div className="flex-1 space-y-1">
                  <span className="inline-block px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-black">
                    بانتظار قبولك
                  </span>
                  <h2 className="text-lg font-black text-slate-900">{meta.name} — {transfer.warehouseName || 'المستودع الرئيسي'}</h2>
                  <p className="text-xs text-slate-500 font-semibold">
                    يجب قبول هذه الشحنة أولاً قبل بدء محطة المسح والاستلام. الكمية المطلوبة: <strong className="text-slate-900">{totalRequired}</strong> قطعة.
                  </p>
                </div>
              </div>

              {acceptError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-extrabold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{acceptError}</span>
                </div>
              )}

              <button
                onClick={handleAcceptTransfer}
                disabled={accepting}
                className="w-full py-3.5 rounded-2xl bg-[#0F5EA8] hover:opacity-90 text-white text-sm font-black flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-60"
              >
                {accepting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>جاري قبول الشحنة...</span>
                  </>
                ) : (
                  <>
                    <PackageCheck className="w-5 h-5" />
                    <span>قبول الشحنة وبدء المسح والاستلام</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Finalized / Read-only state */}
          {isFinalized && (
            <div className="bg-white rounded-3xl p-10 border border-slate-200 shadow-2xs text-center space-y-3">
              <Lock className="w-12 h-12 text-slate-300 mx-auto" />
              <h3 className="text-sm font-black text-slate-700">
                {status === 'REJECTED' ? 'تم رفض هذه الشحنة' : 'تم إغلاق هذه الشحنة بالفعل'}
              </h3>
              <p className="text-xs text-slate-400">لا يمكن إجراء مسح إضافي على شحنة تم إنهاؤها.</p>
            </div>
          )}

          {/* Active scan/receiving station (transfer accepted, not finalized) */}
          {!isPending && !isFinalized && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

              {/* 1. LEFT PANEL (Width 4/12): Shipment Summary & Visual Progress */}
              <div className="lg:col-span-4 space-y-6">

                <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-2xs space-y-6">

                  <div className="border-b border-slate-100 pb-4">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-wider">تفاصيل الشحنة المحولة</span>
                    <h2 className="text-xl font-black text-slate-900 mt-1">
                      TRF-{transferId!.substring(0, 8).toUpperCase()}
                    </h2>
                  </div>

                  <ItemProductAvatar
                  itemTypeKey={transfer.itemType || 'A960'}
                  displayName={itemTypeInfo?.nameAr || itemTypeInfo?.nameEn}
                  displayCategory={itemTypeInfo?.category as any}
                  size="lg"
                  showCategoryPill={true}
                />

                  <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200 space-y-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-bold">المستودع المصدر:</span>
                      <span className="font-extrabold text-slate-900">{transfer.warehouseName || '—'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-bold">إجمالي القطع المطلوب استلامها:</span>
                      <span className="font-extrabold text-[#0F5EA8]">{totalRequired} قطعة</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-bold">طريقة الاستلام:</span>
                      <span className="font-extrabold text-slate-900">
                        {isSerialized ? 'مسح كل رقم تسلسلي فرديًا' : 'استلام كمي (دون سريال)'}
                      </span>
                    </div>
                  </div>

                  {isSerialized && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs font-bold">
                        <span className="text-slate-700">نسبة مطابقة واستلام الشحنة</span>
                        <span className="text-[#0F5EA8] font-black">{progressPercent}%</span>
                      </div>

                      <div className="w-full h-3 rounded-full bg-slate-100 overflow-hidden p-0.5 border border-slate-200">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#0F5EA8] to-[#12C6E8] transition-all duration-300 shadow-xs"
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>

                      <div className="text-[11px] text-center text-slate-500 font-bold">
                        تم مسح <strong className="text-slate-900">{scannedItems.length}</strong> من أصل <strong className="text-slate-900">{totalRequired}</strong> قطعة
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* 2. RIGHT PANEL (Width 8/12) */}
              <div className="lg:col-span-8 space-y-6">

                {isSerialized ? (
                  <>
                    {/* Scanner Input Station Card */}
                    <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-2xs space-y-4">

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <div className="p-2 rounded-xl bg-blue-50 text-[#0F5EA8] shrink-0">
                            <Scan className="w-5 h-5 text-[#12C6E8]" />
                          </div>
                          <div>
                            <h3 className="text-base font-extrabold text-slate-900">محطة القراءة والمسح الضوئي المباشر</h3>
                            <p className="text-xs text-slate-500">وجه قارئ الباركود أو أدخل الرقم التسلسلي SN / ICCID ووافق بالزر</p>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-extrabold border border-emerald-200 shrink-0">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                          <span>جاهز للقراءة التلقائية</span>
                        </div>
                      </div>

                      <form onSubmit={handleScanSubmit} className="relative">
                        <div className="relative flex items-center">
                          <input
                            ref={inputRef}
                            type="text"
                            value={serialInput}
                            onChange={(e) => setSerialInput(e.target.value)}
                            placeholder="امسح الباركود أو أدخل الرقم التسلسلي..."
                            disabled={scanning}
                            className="w-full pl-16 sm:pl-36 pr-12 py-4 rounded-2xl rassco-scan-input text-slate-900 font-mono font-bold text-sm text-right placeholder-slate-400 outline-none transition-all shadow-2xs disabled:opacity-60"
                            autoFocus
                          />
                          <Barcode className="w-5 h-5 text-slate-400 absolute right-4 pointer-events-none" />

                          <button
                            type="submit"
                            disabled={scanning}
                            title="إضافة للقائمة"
                            className="absolute left-2.5 px-3 sm:px-5 py-2.5 rounded-xl rassco-btn-primary text-xs flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-60"
                          >
                            {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlusIcon className="w-4 h-4" />}
                            <span className="hidden sm:inline">{scanning ? 'جاري التحقق...' : 'إضافة للقائمة'}</span>
                          </button>
                        </div>
                      </form>

                      {errorMsg && (
                        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-extrabold flex items-center gap-3 animate-fade-in">
                          <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
                          <span>{errorMsg}</span>
                        </div>
                      )}

                      {successMsg && (
                        <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-extrabold flex items-center gap-3 animate-fade-in">
                          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                          <span>{successMsg}</span>
                        </div>
                      )}

                      {lastScanned && (
                        <div className="p-4 rounded-2xl bg-gradient-to-r from-blue-50/50 to-slate-50 border border-blue-100 flex items-center justify-between text-xs">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-xl bg-[#0F5EA8] text-white flex items-center justify-center font-bold">
                              <Check className="w-4 h-4 text-[#12C6E8]" />
                            </div>
                            <div>
                              <span className="text-[10px] text-slate-500 font-bold">آخر رقم ممسوح بالسكانر:</span>
                              <div className="font-mono font-black text-slate-900 text-sm">{lastScanned.serial}</div>
                            </div>
                          </div>
                          <span className="text-slate-400 font-mono text-[10px]">{lastScanned.timestamp}</span>
                        </div>
                      )}
                    </div>

                    {/* Scanned Items Table Station */}
                    <div className="bg-white rounded-3xl border border-slate-200 shadow-2xs overflow-hidden">

                      <div className="p-6 border-b border-slate-200 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Layers className="w-5 h-5 text-[#0F5EA8]" />
                          <h3 className="text-sm font-extrabold text-slate-900">جدول الأرقام التسلسلية الممسوحة ضوئياً ({scannedItems.length})</h3>
                        </div>
                      </div>

                      {scannedItems.length === 0 ? (
                        <div className="text-center py-16 text-slate-400 space-y-3">
                          <Barcode className="w-12 h-12 text-slate-300 mx-auto" />
                          <p className="text-sm font-extrabold text-slate-600">جدول القراءة فارغ حالياً</p>
                          <p className="text-xs text-slate-400">قم بقراءة باركود الأجهزة والشرائح لإضافتها في الجدول قبل الاعتماد النهائي</p>
                        </div>
                      ) : (
                        <div className="max-h-96 overflow-y-auto">
                          <table className="w-full text-right text-xs">
                            <thead className="bg-slate-50 text-slate-500 font-extrabold border-b border-slate-200 sticky top-0">
                              <tr>
                                <th className="py-3 px-6">#</th>
                                <th className="py-3 px-6">الرقم التسلسلي (SN / ICCID)</th>
                                <th className="py-3 px-6">نوع الصنف</th>
                                <th className="py-3 px-6">توقيت المسح</th>
                                <th className="py-3 px-6 text-center">إزالة</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 font-semibold text-slate-800">
                              {scannedItems.map((item, index) => (
                                <tr key={item.serial} className="hover:bg-slate-50 transition-colors">
                                  <td className="py-3.5 px-6 font-mono text-slate-400">{scannedItems.length - index}</td>
                                  <td className="py-3.5 px-6 font-mono font-black text-slate-900">{item.serial}</td>
                                  <td className="py-3.5 px-6">
                                    <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-[#0F5EA8] text-[10px] font-bold">
                                      {meta.name}
                                    </span>
                                  </td>
                                  <td className="py-3.5 px-6 font-mono text-[11px] text-slate-500">{item.timestamp}</td>
                                  <td className="py-3.5 px-6 text-center">
                                    <button
                                      onClick={() => removeItem(item.serial)}
                                      disabled={removingSerial === item.serial}
                                      className="p-1 text-slate-400 hover:text-rose-600 transition-colors cursor-pointer disabled:opacity-50"
                                      title="التراجع عن هذا المسح (حذف من العهدة)"
                                    >
                                      {removingSerial === item.serial ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                      ) : (
                                        <Trash2 className="w-4 h-4" />
                                      )}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  /* Bulk (non-serialized) receiving summary — no per-serial scan required */
                  <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-2xs text-center space-y-4">
                    <PackageCheck className="w-12 h-12 text-[#0F5EA8] mx-auto" />
                    <h3 className="text-base font-black text-slate-900">استلام كمي — لا يتطلب مسح أرقام تسلسلية</h3>
                    <p className="text-xs text-slate-500 max-w-md mx-auto">
                      هذا الصنف ({meta.name}) يُستلم بالكمية الإجمالية مباشرة ({totalRequired} {transfer.packagingType === 'box' || transfer.packagingType === 'boxes' ? 'صندوق' : 'قطعة'}) دون الحاجة لمسح كل وحدة على حدة.
                    </p>
                    {errorMsg && (
                      <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-extrabold flex items-center gap-2 max-w-md mx-auto">
                        <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                        <span>{errorMsg}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 3. Bottom Sticky Confirmation Bar (only while actively receiving) */}
          {!isPending && !isFinalized && (
            <div className="bg-white rounded-3xl p-6 border border-slate-200 shadow-lg flex flex-col sm:flex-row items-center justify-between gap-4 sticky bottom-4 z-20">

              <div className="flex items-center gap-4 text-right">
                <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-black">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div>
                  <h4 className="text-sm font-black text-slate-900">جاهزية نقل الحضانة والعهدة</h4>
                  <p className="text-xs text-slate-500">
                    {isSerialized
                      ? <>تم تجهيز <strong className="text-emerald-600 font-bold">{scannedItems.length}</strong> من أصل <strong>{totalRequired}</strong> قطعة للاعتماد</>
                      : <>الكمية المطلوبة <strong className="text-emerald-600 font-bold">{totalRequired}</strong> جاهزة للاعتماد المباشر</>
                    }
                  </p>
                </div>
              </div>

              <button
                onClick={handleFinalConfirm}
                disabled={isSubmitting || (isSerialized && !!totalRequired && scannedItems.length < totalRequired)}
                className={`w-full sm:w-auto px-10 py-4 rounded-2xl text-sm font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                  !isSubmitting && (!isSerialized || (totalRequired && scannedItems.length >= totalRequired))
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-900/20'
                    : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                }`}
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    <span>جاري تسجيل ونقل العهدة بالسيرفر...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-5 h-5" />
                    <span>تأكيد واعتماد نقل العهدة إلى حسابي النهائي ✓</span>
                  </>
                )}
              </button>

            </div>
          )}
        </>
      )}

    </div>
  );
};

// Helper Plus Icon
function PlusIcon(props: any) {
  return (
    <svg {...props} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" />
    </svg>
  );
}
