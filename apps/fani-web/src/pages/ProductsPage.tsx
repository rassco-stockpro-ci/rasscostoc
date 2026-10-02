import React, { useState, useEffect, useMemo } from 'react';
import {
  Package,
  Smartphone,
  CreditCard,
  Trash2,
  Eye,
  X,
  Calendar,
  Clock,
  AlertTriangle,
  Loader2,
  History,
  ShieldAlert,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { api } from '../api/client';
import { ItemProductAvatar, getItemMetadata } from '../components/ItemProductAvatar';

interface ProductsPageProps {
  searchQuery: string;
}

const statusLabels: Record<string, { label: string; className: string }> = {
  IN_TRANSIT_CUSTODY: { label: 'قيد النقل إليك', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  RECEIVED_BY_TECHNICIAN: { label: 'في عهدتك', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

export const ProductsPage: React.FC<ProductsPageProps> = ({ searchQuery }) => {
  const [custody, setCustody] = useState<any[]>([]);
  const [itemTypeCategoryMap, setItemTypeCategoryMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'all' | 'devices' | 'sim'>('all');
  const [localSearch, setLocalSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  // Details modal
  const [detailsItem, setDetailsItem] = useState<any | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsData, setDetailsData] = useState<any | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  // Delete modal
  const [deleteItem, setDeleteItem] = useState<any | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [custodyData, itemTypes] = await Promise.all([
      api.getMyCustody(),
      api.getItemTypes(),
    ]);

    const catMap: Record<string, string> = {};
    for (const t of itemTypes || []) {
      if (t?.id) catMap[t.id] = t.category;
    }

    setCustody(custodyData || []);
    setItemTypeCategoryMap(catMap);
    setLoading(false);
  };

  const getCategory = (item: any): string => {
    return itemTypeCategoryMap[item.itemTypeId] || getItemMetadata(item.itemTypeId || '').category;
  };

  const getCustodyItemType = (item: any): 'DEVICE' | 'SIM' => {
    return getCategory(item) === 'sim' ? 'SIM' : 'DEVICE';
  };

  // Distinct product types actually present in custody, for the type filter dropdown
  const productTypes = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of custody) {
      if (item.itemTypeId && !map.has(item.itemTypeId)) {
        map.set(item.itemTypeId, item.itemTypeNameAr || item.itemTypeNameEn || item.itemTypeId);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [custody]);

  const filtered = useMemo(() => {
    const query = (localSearch || searchQuery).toLowerCase().trim();
    return custody.filter((item) => {
      const category = getCategory(item);
      const matchesTab =
        activeTab === 'all' ? true :
        activeTab === 'devices' ? category !== 'sim' :
        category === 'sim';

      const matchesType = typeFilter === 'all' || item.itemTypeId === typeFilter;

      const matchesSearch = !query ||
        (item.serialNumber && item.serialNumber.toLowerCase().includes(query)) ||
        (item.itemTypeNameAr && item.itemTypeNameAr.toLowerCase().includes(query)) ||
        (item.itemTypeNameEn && item.itemTypeNameEn.toLowerCase().includes(query)) ||
        (item.carrierName && item.carrierName.toLowerCase().includes(query));

      return matchesTab && matchesType && matchesSearch;
    });
  }, [custody, activeTab, typeFilter, localSearch, searchQuery, itemTypeCategoryMap]);

  const deviceCount = custody.filter((i) => getCategory(i) !== 'sim').length;
  const simCount = custody.filter((i) => getCategory(i) === 'sim').length;

  const openDetails = async (item: any) => {
    setDetailsItem(item);
    setDetailsData(null);
    setDetailsError(null);
    setDetailsLoading(true);
    const res = await api.lookupSerial(item.serialNumber);
    setDetailsLoading(false);
    if (res.success) {
      setDetailsData(res.data);
    } else {
      setDetailsError(res.message || 'تعذر تحميل بيانات المادة');
    }
  };

  const closeDetails = () => {
    setDetailsItem(null);
    setDetailsData(null);
    setDetailsError(null);
  };

  const openDelete = (item: any) => {
    setDeleteItem(item);
    setConfirmInput('');
    setDeleteReason('');
    setDeleteError(null);
  };

  const closeDelete = () => {
    setDeleteItem(null);
    setConfirmInput('');
    setDeleteReason('');
    setDeleteError(null);
  };

  const handleDelete = async () => {
    if (!deleteItem) return;
    if (confirmInput.trim() !== deleteItem.serialNumber) {
      setDeleteError('الرقم الذي أدخلته لا يطابق الرقم التسلسلي المطلوب حذفه');
      return;
    }

    setDeleting(true);
    setDeleteError(null);

    const res = await api.deleteCustodyItem(
      getCustodyItemType(deleteItem),
      deleteItem.serialNumber,
      confirmInput.trim(),
      deleteReason.trim() || undefined
    );

    setDeleting(false);

    if (res.success) {
      setCustody((prev) => prev.filter((i) => i.id !== deleteItem.id));
      closeDelete();
    } else {
      setDeleteError(res.message || 'فشل حذف المادة');
    }
  };

  return (
    <div className="space-y-6">

      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-5 sm:p-6 rounded-3xl border border-slate-200 shadow-2xs">
        <div className="text-right space-y-1">
          <h1 className="text-xl sm:text-2xl font-black text-slate-900 font-['Cairo']">منتجاتي وعهدتي المخزنية</h1>
          <p className="text-xs font-semibold text-slate-500">
            جميع الأجهزة والشرائح المسجّلة حاليًا في عهدتك الشخصية — يمكنك عرض التفاصيل أو الحذف عند الحاجة
          </p>
        </div>
        <div className="px-4 py-2.5 rounded-2xl bg-slate-50 border border-slate-200 text-xs font-mono font-extrabold text-slate-600 flex items-center gap-2 shadow-2xs shrink-0">
          <Package className="w-4 h-4 text-[#0F5EA8]" />
          <span>{custody.length} مادة في العهدة</span>
        </div>
      </div>

      {/* KPI Cards */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs flex items-center justify-between">
          <div className="text-right">
            <span className="text-[11px] font-extrabold text-slate-400">إجمالي المواد</span>
            <div className="text-xl font-black text-slate-900 mt-0.5">{custody.length}</div>
          </div>
          <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
            <Package className="w-5 h-5" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs flex items-center justify-between">
          <div className="text-right">
            <span className="text-[11px] font-extrabold text-slate-400">الأجهزة</span>
            <div className="text-xl font-black text-blue-600 mt-0.5">{deviceCount}</div>
          </div>
          <div className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
            <Smartphone className="w-5 h-5" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-2xs flex items-center justify-between">
          <div className="text-right">
            <span className="text-[11px] font-extrabold text-slate-400">الشرائح</span>
            <div className="text-xl font-black text-purple-600 mt-0.5">{simCount}</div>
          </div>
          <div className="w-10 h-10 rounded-full bg-purple-50 text-purple-600 flex items-center justify-center shrink-0">
            <CreditCard className="w-5 h-5" />
          </div>
        </div>
      </section>

      {/* Search & Filters Bar */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-2xs p-5 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3">
          {/* Dedicated Search Field */}
          <div className="flex-1 relative">
            <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none text-slate-400">
              <Search className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              placeholder="ابحث بالرقم التسلسلي، اسم الصنف، أو الشركة الناقلة..."
              className="w-full pl-4 pr-11 py-3 rounded-2xl bg-slate-50 border border-slate-200 text-slate-900 placeholder-slate-400 text-xs font-semibold focus:bg-white focus:border-[#0F5EA8] focus:ring-2 focus:ring-[#0F5EA8]/15 outline-none transition-all"
            />
          </div>

          {/* Product Type Filter */}
          <div className="relative lg:w-64 shrink-0">
            <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none text-slate-400">
              <SlidersHorizontal className="w-4 h-4" />
            </div>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="w-full pl-4 pr-11 py-3 rounded-2xl bg-slate-50 border border-slate-200 text-slate-900 text-xs font-bold focus:bg-white focus:border-[#0F5EA8] focus:ring-2 focus:ring-[#0F5EA8]/15 outline-none transition-all appearance-none cursor-pointer"
            >
              <option value="all">كل أصناف المنتجات</option>
              {productTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Category Tabs */}
        <div className="flex items-center gap-2 bg-slate-100 p-1 rounded-2xl text-xs font-bold text-slate-600 w-fit">
          <button
            onClick={() => setActiveTab('all')}
            className={`px-4 py-1.5 rounded-xl transition-all cursor-pointer ${activeTab === 'all' ? 'bg-[#00A896] text-white font-black shadow-2xs' : 'hover:text-slate-900'}`}
          >
            الكل ({custody.length})
          </button>
          <button
            onClick={() => setActiveTab('devices')}
            className={`px-4 py-1.5 rounded-xl transition-all cursor-pointer ${activeTab === 'devices' ? 'bg-[#00A896] text-white font-black shadow-2xs' : 'hover:text-slate-900'}`}
          >
            أجهزة ({deviceCount})
          </button>
          <button
            onClick={() => setActiveTab('sim')}
            className={`px-4 py-1.5 rounded-xl transition-all cursor-pointer ${activeTab === 'sim' ? 'bg-[#00A896] text-white font-black shadow-2xs' : 'hover:text-slate-900'}`}
          >
            شرائح ({simCount})
          </button>
        </div>
      </div>

      {/* Products Card Grid */}
      {loading ? (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-2xs py-20 text-center text-slate-400 text-xs font-bold">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-[#0F5EA8]" />
          جاري تحميل عهدتك...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-2xs py-20 text-center">
          <div className="flex flex-col items-center gap-2 text-slate-400">
            <Package className="w-10 h-10 text-slate-300" />
            <span className="text-sm font-extrabold text-slate-600">لا توجد منتجات مطابقة</span>
            <span className="text-xs font-semibold text-slate-400">
              {(localSearch || searchQuery || typeFilter !== 'all') ? 'جرّب تعديل البحث أو الفلاتر' : 'ستظهر هنا الأجهزة والشرائح بعد استلامها من الشحنات'}
            </span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((item) => {
            const status = statusLabels[item.status] || { label: item.status || '—', className: 'bg-slate-50 text-slate-600 border-slate-200' };
            return (
              <div
                key={item.id}
                className="bg-white rounded-3xl border border-slate-200 shadow-2xs hover:shadow-md hover:-translate-y-0.5 transition-all p-5 flex flex-col gap-4"
              >
                {/* Card Top: Avatar + Status */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <ItemProductAvatar
                      itemTypeKey={item.itemTypeId || 'A960'}
                      displayName={item.itemTypeNameAr || item.itemTypeNameEn}
                      displayCategory={getCategory(item) === 'sim' ? 'sim' : 'devices'}
                      size="md"
                      showSubtext={false}
                    />
                  </div>
                  <span className={`shrink-0 inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-extrabold border whitespace-nowrap ${status.className}`}>
                    {status.label}
                  </span>
                </div>

                {/* Serial Number */}
                <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
                  <span className="block text-[10px] font-bold text-slate-400 mb-0.5">الرقم التسلسلي</span>
                  <span className="font-mono font-black text-slate-900 text-sm break-all">{item.serialNumber}</span>
                </div>

                {/* Meta Row */}
                <div className="space-y-2 text-[11px] text-slate-500 font-semibold">
                  {item.carrierName && (
                    <div className="flex items-center justify-between">
                      <span>الشركة الناقلة</span>
                      <span className="font-extrabold text-slate-700">{item.carrierName}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> تاريخ الاستلام</span>
                    <span className="font-extrabold text-slate-700">
                      {item.createdAt ? new Date(item.createdAt).toLocaleDateString('ar-SA') : '—'}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 pt-2 border-t border-slate-100 mt-auto">
                  <button
                    onClick={() => openDetails(item)}
                    className="flex-1 py-2 rounded-xl bg-blue-50 text-[#0F5EA8] hover:bg-blue-100 transition-all cursor-pointer text-xs font-black flex items-center justify-center gap-1.5"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>التفاصيل</span>
                  </button>
                  <button
                    onClick={() => openDelete(item)}
                    className="flex-1 py-2 rounded-xl bg-rose-50 text-rose-600 hover:bg-rose-100 transition-all cursor-pointer text-xs font-black flex items-center justify-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>حذف</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Details Modal */}
      {detailsItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4" onClick={closeDetails}>
          <div
            className="w-full max-w-lg bg-white rounded-3xl shadow-2xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-200 flex items-center justify-between bg-slate-50 rounded-t-3xl">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-blue-50 text-[#0F5EA8] border border-blue-100">
                  <History className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-slate-900">تفاصيل المادة والسجل الزمني</h3>
                  <p className="text-xs text-slate-500 font-mono">{detailsItem.serialNumber}</p>
                </div>
              </div>
              <button onClick={closeDetails} className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-all cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              {detailsLoading && (
                <div className="py-10 text-center text-slate-400">
                  <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2 text-[#0F5EA8]" />
                  <span className="text-xs font-bold">جاري تحميل السجل...</span>
                </div>
              )}

              {detailsError && !detailsLoading && (
                <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-extrabold flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0" />
                  <span>{detailsError}</span>
                </div>
              )}

              {detailsData && !detailsLoading && (
                <>
                  <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-bold">نوع الصنف:</span>
                      <span className="font-extrabold text-slate-900">{detailsData.itemTypeNameAr || detailsData.itemTypeNameEn || '—'}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-bold">الحالة الحالية:</span>
                      <span className="font-extrabold text-[#0F5EA8]">{statusLabels[detailsData.status]?.label || detailsData.status || '—'}</span>
                    </div>
                    {detailsData.carrierName && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 font-bold">الشركة الناقلة:</span>
                        <span className="font-extrabold text-slate-900">{detailsData.carrierName}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500 font-bold">تاريخ التسجيل:</span>
                      <span className="font-extrabold text-slate-900">
                        {detailsData.createdAt ? new Date(detailsData.createdAt).toLocaleString('ar-SA') : '—'}
                      </span>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-xs font-black text-slate-900 mb-2 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      سجل حركة المادة
                    </h4>
                    {Array.isArray(detailsData.history) && detailsData.history.length > 0 ? (
                      <div className="space-y-2">
                        {detailsData.history.map((h: any) => (
                          <div key={h.id} className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-[11px] space-y-1">
                            <div className="flex items-center justify-between font-bold">
                              <span className="text-slate-700">{h.fromStatus || '—'} ← {h.toStatus || '—'}</span>
                              <span className="text-slate-400 font-mono">
                                {h.changedAt ? new Date(h.changedAt).toLocaleString('ar-SA') : ''}
                              </span>
                            </div>
                            {h.notes && <p className="text-slate-500">{h.notes}</p>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 font-semibold text-center py-4">لا يوجد سجل حركة إضافي لهذه المادة</p>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4" onClick={closeDelete}>
          <div
            className="w-full max-w-md bg-white rounded-3xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-200 flex items-center gap-3 bg-rose-50 rounded-t-3xl">
              <div className="p-2.5 rounded-xl bg-rose-100 text-rose-600 border border-rose-200">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-extrabold text-slate-900">تأكيد حذف المادة من العهدة</h3>
                <p className="text-xs text-rose-700 font-semibold">هذا الإجراء لا يمكن التراجع عنه</p>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center gap-3 min-w-0">
                <ItemProductAvatar
                  itemTypeKey={deleteItem.itemTypeId || 'A960'}
                  displayName={deleteItem.itemTypeNameAr || deleteItem.itemTypeNameEn}
                  displayCategory={getCategory(deleteItem) === 'sim' ? 'sim' : 'devices'}
                  size="sm"
                  showSubtext={false}
                  className="min-w-0"
                />
              </div>

              <div>
                <label className="block text-xs font-extrabold text-slate-700 mb-2">
                  اكتب الرقم التسلسلي <span className="font-mono text-rose-600">{deleteItem.serialNumber}</span> للتأكيد
                </label>
                <input
                  type="text"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder="أعد كتابة الرقم التسلسلي هنا..."
                  className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 text-slate-900 font-mono font-bold text-sm text-right focus:bg-white focus:border-rose-500 focus:ring-2 focus:ring-rose-500/15 outline-none transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-extrabold text-slate-700 mb-2">سبب الحذف (اختياري)</label>
                <textarea
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder="مثال: تم تسجيل الرقم التسلسلي بشكل خاطئ..."
                  rows={2}
                  className="w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 text-slate-900 text-sm text-right focus:bg-white focus:border-[#0F5EA8] focus:ring-2 focus:ring-[#0F5EA8]/15 outline-none transition-all resize-none"
                />
              </div>

              {deleteError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-extrabold flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{deleteError}</span>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={closeDelete}
                  className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-700 text-xs font-black hover:bg-slate-200 transition-all cursor-pointer"
                >
                  إلغاء
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting || confirmInput.trim() !== deleteItem.serialNumber}
                  className={`flex-1 py-3 rounded-2xl text-xs font-black flex items-center justify-center gap-2 transition-all cursor-pointer ${
                    !deleting && confirmInput.trim() === deleteItem.serialNumber
                      ? 'bg-rose-600 hover:bg-rose-700 text-white'
                      : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  {deleting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>جاري الحذف...</span>
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4" />
                      <span>تأكيد الحذف نهائيًا</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
