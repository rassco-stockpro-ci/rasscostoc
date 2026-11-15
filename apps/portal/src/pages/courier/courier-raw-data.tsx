import { useTranslation } from "@/lib/language";
import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCourierRenderPerf } from "@/hooks/use-courier-render-perf";
import { motion } from "framer-motion";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Edit2,
  Trash2,
  Upload,
  X,
  Database,
  MoreVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface RequestRow {
  id: number;
  date: string | null;
  tid: string | null;
  terminalId: string | null;
  incidentNumber: string | null;
  ticketingHolouly: string | null;
  installationType: string | null;
  sim: string | null;
  simSn: string | null;
  idData: string | null;
  otp: string | null;
  pinCode: string | null;
  trsm: string | null;
  vendorType: string | null;
  city: string | null;
  cityTec: string | null;
  addressAr: string | null;
  addressEn: string | null;
  customerName: string | null;
  retailerName: string | null;
  mobile: string | null;
  mobile2: string | null;
  tecName: string | null;
  execution: {
    installationStatus: string | null;
    salesTechnician: string | null;
  } | null;
  version?: number;
}

interface ListResponse {
  rows: RequestRow[];
  total: number;
}

interface LookupsResponse {
  cities: Array<{ id: number; name_en: string; name_ar: string }>;
  vendorTypes: Array<{ id: number; name: string }>;
}

const PAGE_SIZE = 25;

export default function CourierRawDataPage() {
  const { t, dir } = useTranslation();
  const { toast } = useToast();
  useCourierRenderPerf("raw_data");
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false);
  const [editRow, setEditRow] = useState<RequestRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form State
  const [formValues, setFormValues] = useState<Partial<RequestRow>>({});

  const { data: lookups } = useQuery<LookupsResponse>({
    queryKey: ["/api/courier/lookups"],
    queryFn: () => apiRequest("GET", "/api/courier/lookups").then((r) => r.json())
  });

  const { data, isLoading } = useQuery<ListResponse>({
    queryKey: ["/api/courier/requests", q, page, "raw_only"],
    queryFn: () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      return apiRequest("GET", `/api/courier/requests?${params.toString()}`).then((r) => r.json());
    }
  });

  const handleOpenAdd = () => {
    setFormValues({
      date: new Date().toISOString().slice(0, 10),
      installationType: "",
      incidentNumber: "",
      ticketingHolouly: "",
      tid: "",
      terminalId: "",
      sim: "",
      simSn: "",
      idData: "",
      otp: "",
      pinCode: "",
      trsm: "",
      vendorType: "",
      city: "",
      cityTec: "",
      addressAr: "",
      addressEn: "",
      customerName: "",
      retailerName: "",
      mobile: "",
      mobile2: "",
      tecName: ""
    });
    setShowAdd(true);
  };

  const handleOpenEdit = (row: RequestRow) => {
    setFormValues({ ...row });
    setEditRow(row);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        date: formValues.date,
        installation_type: formValues.installationType,
        incident_number: formValues.incidentNumber,
        ticketing_holouly: formValues.ticketingHolouly,
        tid: formValues.tid,
        terminal_id: formValues.terminalId,
        sim: formValues.sim,
        sim_sn: formValues.simSn,
        id_data: formValues.idData,
        otp: formValues.otp,
        pin_code: formValues.pinCode,
        trsm: formValues.trsm,
        vendor_type: formValues.vendorType,
        city: formValues.city,
        city_tec: formValues.cityTec,
        address_ar: formValues.addressAr,
        address_en: formValues.addressEn,
        customer_name: formValues.customerName,
        retailer_name: formValues.retailerName,
        mobile: formValues.mobile,
        mobile2: formValues.mobile2,
        tec_name: formValues.tecName,
        version: editRow ? formValues.version : undefined
      };

      if (editRow) {
        await apiRequest("PUT", `/api/courier/requests/${editRow.id}`, payload);
        toast({ title: t('courier.completed_edit_successfully'), description: t('courier.completed_update_data') });
      } else {
        await apiRequest("POST", "/api/courier/requests", payload);
        toast({ title: t('courier.completed_add_successfully'), description: t('courier.completed_request_new_successf') });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/courier/requests"] });
      setShowAdd(false);
      setEditRow(null);
    } catch (err: any) {
      toast({
        title: t('courier.error_save'),
        description: err.message || t('courier.error_1'),
        variant: "destructive"
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm(t('courier.delete_request'))) return;
    try {
      await apiRequest("DELETE", `/api/courier/requests/${id}`);
      toast({ title: t('courier.completed_delete_successfully'), description: t('courier.completed_scan_request_system') });
      queryClient.invalidateQueries({ queryKey: ["/api/courier/requests"] });
    } catch (err: any) {
      toast({
        title: t('courier.fail_delete'),
        description: err.message || t('courier.error_1'),
        variant: "destructive"
      });
    }
  };

  const handleImportFile = async (file: File) => {
    setImporting(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/courier/requests/import", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("auth-token") || ""}`
        },
        body: formData
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || t('courier.fail_import'));
      
      toast({
        title: t('courier.import_1'),
        description: t('courier.completed_submit_request_duplicate', { var_0: result.importedCount, var_1: result.skippedCount })
      });
      queryClient.invalidateQueries({ queryKey: ["/api/courier/requests"] });
    } catch (err: any) {
      toast({
        title: t('courier.error_import'),
        description: err.message || t('courier.fail_file'),
        variant: "destructive"
      });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const total = data?.total || 0;
  const rows = data?.rows || [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div dir={dir} className="rassco-page space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col md:flex-row md:items-center justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#2D3135] flex items-center gap-3">
            <span className="courier-icon-badge">
              <Database className="w-5 h-5" />
            </span>
            {t('courier.management_data')}
          </h1>
          <p className="text-sm text-[#6B7280] mt-1.5 ps-14">
            {t('courier.submit_data_delivery')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && handleImportFile(e.target.files[0])}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            className="courier-btn-secondary"
          >
            {importing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5" />
            )}
            {t('courier.import_2')}
          </button>
          <button onClick={handleOpenAdd} className="courier-btn-primary em-ripple">
            <Plus className="w-3.5 h-3.5" />
            {t('courier.request_new')}
          </button>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.04 }}
        className="courier-toolbar"
      >
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6B7280]" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder={t('courier.name_technician_1')}
            className="courier-input pr-10"
          />
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="courier-panel courier-panel-static"
      >
        <div className="courier-table-wrap">
          <table className="courier-table whitespace-nowrap">
            <thead>
              <tr>
                <th>{t('courier.date_2')}</th>
                <th>TID</th>
                <th>Terminal ID</th>
                <th>{t('courier.type')}</th>
                <th>{t('courier.city')}</th>
                <th>{t('courier.customer_1')}</th>
                <th>{t('courier.mobile')}</th>
                <th>{t('courier.name_technician')}</th>
                <th>{t('courier.item_14214')}</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="text-center py-16 text-[#6B7280]">
                    <Loader2 className="animate-spin w-5 h-5 inline-block me-2 text-[#18B2B0]" />
                    {t('courier.loading_data')}
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-16 text-[#6B7280]">
                    {t('courier.no_requests')}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td className="text-[#4B5563]">{row.date || "—"}</td>
                    <td className="font-mono font-semibold text-[#18B2B0]">{row.tid || "—"}</td>
                    <td className="font-mono text-[#4B5563]">{row.terminalId || "—"}</td>
                    <td className="text-[#4B5563]">{row.installationType || "—"}</td>
                    <td className="text-[#4B5563]">{row.city || "—"}</td>
                    <td className="font-semibold text-[#2D3135]">{row.customerName || "—"}</td>
                    <td className="font-mono text-xs text-[#6B7280]">{row.mobile || "—"}</td>
                    <td className="text-[#4B5563]">{row.execution?.salesTechnician || row.tecName || "—"}</td>
                    <td>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="courier-actions-trigger"
                            aria-label={t("courier.item_14214")}
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="courier-actions-menu"
                        >
                          <DropdownMenuItem
                            className="courier-actions-item"
                            onClick={() => handleOpenEdit(row)}
                          >
                            <Edit2 className="w-4 h-4" />
                            {t("courier.edit_2")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="courier-actions-item courier-actions-item-danger"
                            onClick={() => handleDelete(row.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                            {t("courier.delete_3")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </motion.div>

      <div className="flex items-center justify-between text-sm text-[#6B7280]">
        <span className="font-semibold">
          {t('courier.page_of_with_total', { page, totalPages, total })}
        </span>
        <div className="flex gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="p-2 rounded-xl border border-[rgba(24,178,176,0.18)] bg-white hover:border-[#18B2B0] hover:text-[#18B2B0] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="p-2 rounded-xl border border-[rgba(24,178,176,0.18)] bg-white hover:border-[#18B2B0] hover:text-[#18B2B0] disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Add / Edit modal */}
      {(showAdd || editRow) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="w-full max-w-4xl max-h-[90vh] flex flex-col courier-panel courier-panel-static shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-[rgba(24,178,176,0.16)] flex items-center justify-between">
              <h3 className="text-lg font-extrabold text-[#2D3135]">
                {editRow ? t('courier.edit_request', { var_0: editRow.id }) : t('courier.submit_request_new')}
              </h3>
              <button
                onClick={() => {
                  setShowAdd(false);
                  setEditRow(null);
                }}
                className="p-1.5 rounded-lg text-[#6B7280] hover:text-[#2D3135] hover:bg-[#18B2B0]/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Group 1: Request Info */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[#18B2B0] mb-3 border-r-2 border-[#18B2B0] pr-2">
                  {t('courier.data_request')}
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.date_2')}</label>
                    <input
                      type="date"
                      required
                      value={formValues.date || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, date: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.type')}</label>
                    <input
                      type="text"
                      value={formValues.installationType || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, installationType: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.number')}</label>
                    <input
                      type="text"
                      value={formValues.incidentNumber || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, incidentNumber: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.item_15966')}</label>
                    <input
                      type="text"
                      value={formValues.ticketingHolouly || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, ticketingHolouly: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                </div>
              </div>

              {/* Group 2: Device & SIM */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[#18B2B0] mb-3 border-r-2 border-[#18B2B0] pr-2">
                  {t('courier.data_device')}
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.number_1')}</label>
                    <input
                      type="text"
                      required
                      value={formValues.tid || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, tid: e.target.value }))}
                      className="courier-input font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.number_2')}</label>
                    <input
                      type="text"
                      value={formValues.terminalId || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, terminalId: e.target.value }))}
                      className="courier-input font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.sim')}</label>
                    <input
                      type="text"
                      value={formValues.sim || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, sim: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.number_serial')}</label>
                    <input
                      type="text"
                      value={formValues.simSn || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, simSn: e.target.value }))}
                      className="courier-input font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">ID Data</label>
                    <input
                      type="text"
                      value={formValues.idData || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, idData: e.target.value }))}
                      className="courier-input font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.verification_1')}</label>
                    <input
                      type="text"
                      value={formValues.otp || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, otp: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.item_5039')}</label>
                    <input
                      type="text"
                      value={formValues.pinCode || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, pinCode: e.target.value }))}
                      className="courier-input font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">TRSM</label>
                    <input
                      type="text"
                      value={formValues.trsm || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, trsm: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.item_20713')}</label>
                    <select
                      value={formValues.vendorType || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, vendorType: e.target.value }))}
                      className="courier-input"
                    >
                      <option value="">{t('courier.item_27065')}</option>
                      {lookups?.vendorTypes.map((v) => (
                        <option key={v.id} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Group 3: Location */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[#18B2B0] mb-3 border-r-2 border-[#18B2B0] pr-2">
                  {t('courier.signed')}
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.city')}</label>
                    <select
                      value={formValues.city || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, city: e.target.value }))}
                      className="courier-input"
                    >
                      <option value="">{t('courier.city_1')}</option>
                      {lookups?.cities.map((c) => (
                        <option key={c.id} value={c.name_en}>
                          {c.name_en}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.city_technician')}</label>
                    <input
                      type="text"
                      value={formValues.cityTec || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, cityTec: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.item_23895')}</label>
                    <input
                      type="text"
                      value={formValues.addressAr || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, addressAr: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                </div>
              </div>

              {/* Group 4: Customer */}
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[#18B2B0] mb-3 border-r-2 border-[#18B2B0] pr-2">
                  {t('courier.data_customer')}
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.name_customer')}</label>
                    <input
                      type="text"
                      value={formValues.customerName || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, customerName: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.name')}</label>
                    <input
                      type="text"
                      value={formValues.retailerName || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, retailerName: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.name_delivery')}</label>
                    <input
                      type="text"
                      value={formValues.tecName || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, tecName: e.target.value }))}
                      className="courier-input"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.number_mobile')}</label>
                    <input
                      type="text"
                      value={formValues.mobile || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, mobile: e.target.value }))}
                      className="courier-input font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B7280] mb-1">{t('courier.number_mobile_1')}</label>
                    <input
                      type="text"
                      value={formValues.mobile2 || ""}
                      onChange={(e) => setFormValues((v) => ({ ...v, mobile2: e.target.value }))}
                      className="courier-input font-mono text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end gap-3 pt-6 border-t border-[rgba(24,178,176,0.16)]">
                <button
                  type="button"
                  onClick={() => {
                    setShowAdd(false);
                    setEditRow(null);
                  }}
                  className="courier-btn-secondary"
                >
                  {t('courier.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="courier-btn-primary em-ripple"
                >
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {t('courier.save_data_1')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
