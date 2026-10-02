import { useState, useRef } from "react";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Upload, FileSpreadsheet, Loader2, CheckCircle2, AlertTriangle, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useActiveItemTypes } from "@/hooks/use-item-types";

interface ImportTechnicianInventoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  technicianId: string;
  itemTypeId?: string;
  itemTypeName?: string;
  onSuccess?: () => void;
}

interface ParsedImportRow {
  serialNumber: string;
  itemTypeId: string;
  itemTypeName: string;
  carrierName?: string;
  isValid: boolean;
  error?: string;
}

// Download Sample Template Helper Function
export async function downloadImportTemplate(itemTypeName?: string) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("نموذج_استيراد_العهدة");
  worksheet.views = [{ rightToLeft: true }];

  worksheet.columns = [
    { header: "الرقم التسلسلي (مطلوب)", key: "serialNumber", width: 30 },
    { header: "اسم نوع الصنف", key: "itemTypeName", width: 25 },
    { header: "الشركة المشغلة (للشرائح فقط: Lebara, STC, Mobily, Zain)", key: "carrierName", width: 42 },
  ];

  // Example sample rows
  worksheet.addRow({
    serialNumber: "SN-98234101",
    itemTypeName: itemTypeName || "أجهزة POS",
    carrierName: "",
  });
  worksheet.addRow({
    serialNumber: "899660123456789",
    itemTypeName: "شرائح SIM",
    carrierName: "STC",
  });
  worksheet.addRow({
    serialNumber: "899660987654321",
    itemTypeName: "شرائح ليبارا",
    carrierName: "Lebara",
  });

  // Style header row
  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "1E40AF" },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  saveAs(new Blob([buffer]), "نموذج_استيراد_مخزون_الفني.xlsx");
}

export function ImportTechnicianInventoryModal({
  isOpen,
  onClose,
  technicianId,
  itemTypeId,
  itemTypeName,
  onSuccess,
}: ImportTechnicianInventoryModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: itemTypes = [] } = useActiveItemTypes();
  const [parsedRows, setParsedRows] = useState<ParsedImportRow[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [isParsing, setIsParsing] = useState(false);

  const handleDownloadTemplate = () => {
    downloadImportTemplate(itemTypeName || itemTypes[0]?.nameAr);
  };

  // Handle File Change & Parsing
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setIsParsing(true);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const worksheet = workbook.worksheets[0];
      if (!worksheet) {
        throw new Error("الملف فارغ أو غير صالح");
      }

      const rows: ParsedImportRow[] = [];
      const serialSet = new Set<string>();

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip Header

        const rawSerial = row.getCell(1).value?.toString()?.trim() || "";
        const rawItemType = row.getCell(2).value?.toString()?.trim() || "";
        const rawCarrier = row.getCell(3).value?.toString()?.trim() || "";

        if (!rawSerial) return; // Skip empty row

        // Determine Item Type ID
        let resolvedItemTypeId = itemTypeId || "";
        let resolvedItemTypeName = itemTypeName || "";

        if (!resolvedItemTypeId && rawItemType) {
          const matched = itemTypes.find(
            (t) =>
              t.nameAr.toLowerCase() === rawItemType.toLowerCase() ||
              t.nameEn.toLowerCase() === rawItemType.toLowerCase() ||
              t.id === rawItemType
          );
          if (matched) {
            resolvedItemTypeId = matched.id;
            resolvedItemTypeName = matched.nameAr;
          }
        }

        if (!resolvedItemTypeId && itemTypes.length > 0) {
          resolvedItemTypeId = itemTypes[0].id;
          resolvedItemTypeName = itemTypes[0].nameAr;
        }

        const isDuplicateInFile = serialSet.has(rawSerial);
        serialSet.add(rawSerial);

        const isValid = !!rawSerial && !!resolvedItemTypeId && !isDuplicateInFile;
        let error = "";
        if (!rawSerial) error = "الرقم التسلسلي مفقود";
        else if (!resolvedItemTypeId) error = "نوع الصنف غير محدد";
        else if (isDuplicateInFile) error = "مكرر في الملف";

        rows.push({
          serialNumber: rawSerial,
          itemTypeId: resolvedItemTypeId,
          itemTypeName: resolvedItemTypeName,
          carrierName: rawCarrier || undefined,
          isValid,
          error,
        });
      });

      setParsedRows(rows);
      if (rows.length === 0) {
        toast({
          title: "الملف لا يحتوي على بيانات",
          description: "لم يتم العثور على أرقام تسلسلية في الملف المرفق",
          variant: "destructive",
        });
      }
    } catch (err: any) {
      toast({
        title: "خطأ في قراءة ملف الإكسل",
        description: err.message || "تأكد من صيغة الملف بصيغة .xlsx",
        variant: "destructive",
      });
    } finally {
      setIsParsing(false);
    }
  };

  // Submit Mutation
  const importMutation = useMutation({
    mutationFn: async () => {
      const validItems = parsedRows
        .filter((r) => r.isValid)
        .map((r) => ({
          serialNumber: r.serialNumber,
          itemTypeId: r.itemTypeId,
          carrierName: r.carrierName,
        }));

      if (validItems.length === 0) {
        throw new Error("لا توجد عناصر صالحة للاستيراد");
      }

      return await apiRequest("POST", "/api/serialized-items/batch-scan-in", {
        technicianId,
        items: validItems,
      });
    },
    onSuccess: (data: any) => {
      toast({
        title: "تم الاستيراد بنجاح",
        description: data.message || `تمت إضافة ${parsedRows.filter((r) => r.isValid).length} من العناصر إلى عهدة الفني`,
      });

      // Invalidate target technician custody queries
      queryClient.invalidateQueries({ queryKey: [`/api/technicians/${technicianId}/serialized-items`] });
      queryClient.invalidateQueries({ queryKey: [`/api/technicians/${technicianId}/moving-inventory-entries`] });
      queryClient.invalidateQueries({ queryKey: [`/api/technicians/${technicianId}/fixed-inventory-entries`] });

      if (onSuccess) onSuccess();
      handleResetAndClose();
    },
    onError: (err: any) => {
      toast({
        title: "فشل استيراد المخزون",
        description: err.message || "حدث خطأ أثناء حفظ المواد في العهدة",
        variant: "destructive",
      });
    },
  });

  const handleResetAndClose = () => {
    setParsedRows([]);
    setFileName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    onClose();
  };

  const validCount = parsedRows.filter((r) => r.isValid).length;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleResetAndClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="space-y-2 text-right">
          <DialogTitle className="text-xl font-bold flex items-center gap-2 justify-start">
            <FileSpreadsheet className="h-6 w-6 text-blue-600" />
            استيراد عهدة الفني من ملف إكسل
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-500">
            قم برفع ملف إكسل يحتوي على الأرقام التسلسلية لإضافتها مباشرة إلى عهدة الفني.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 flex-1 overflow-y-auto pr-1">
          {/* Top Actions Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-50 dark:bg-slate-900 p-4 rounded-xl border">
            <div>
              <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">تحميل النموذج القياسي</p>
              <p className="text-xs text-gray-500">استخدم هذا النموذج لترتيب الأعمدة قبل الرفع</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleDownloadTemplate}
              className="gap-2 shrink-0 text-blue-600 border-blue-200 hover:bg-blue-50"
            >
              <Download className="h-4 w-4" />
              تحميل نموذج Excel
            </Button>
          </div>

          {/* Upload Input Area */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-blue-300 dark:border-blue-800 hover:border-blue-500 bg-blue-50/50 dark:bg-blue-950/20 p-6 rounded-xl text-center cursor-pointer transition-colors"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx, .xls, .csv"
              onChange={handleFileChange}
              className="hidden"
            />
            {isParsing ? (
              <div className="flex flex-col items-center justify-center py-4 text-blue-600 gap-2">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="text-sm font-medium">جاري قراءة وتحليل بيانات الملف...</span>
              </div>
            ) : fileName ? (
              <div className="flex items-center justify-center gap-3 text-emerald-700 dark:text-emerald-400">
                <FileSpreadsheet className="h-8 w-8" />
                <div className="text-right">
                  <p className="text-sm font-bold">{fileName}</p>
                  <p className="text-xs text-gray-500">انقر لتغيير الملف</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 text-gray-600 dark:text-gray-400">
                <Upload className="h-8 w-8 text-blue-500" />
                <p className="text-sm font-semibold">انقر هنا لاختيار ملف الإكسل</p>
                <p className="text-xs text-gray-400">الصيغ المدعومة: .xlsx, .xls, .csv</p>
              </div>
            )}
          </div>

          {/* Parsed Rows Preview Table */}
          {parsedRows.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-gray-700 dark:text-gray-300">
                  معاينة المواد ({parsedRows.length} إجمالي)
                </span>
                <div className="flex gap-2">
                  <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                    صالح: {validCount}
                  </Badge>
                  {parsedRows.length - validCount > 0 && (
                    <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
                      غير صالح: {parsedRows.length - validCount}
                    </Badge>
                  )}
                </div>
              </div>

              <div className="max-h-48 overflow-y-auto border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-100 dark:bg-slate-800 text-xs">
                      <TableHead className="text-right">الرقم التسلسلي</TableHead>
                      <TableHead className="text-right">نوع الصنف</TableHead>
                      <TableHead className="text-right">الشركة المشغلة</TableHead>
                      <TableHead className="text-center">الحالة</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsedRows.map((row, idx) => (
                      <TableRow key={idx} className="text-xs">
                        <TableCell className="font-mono font-medium">{row.serialNumber}</TableCell>
                        <TableCell>{row.itemTypeName || "-"}</TableCell>
                        <TableCell>{row.carrierName || "-"}</TableCell>
                        <TableCell className="text-center">
                          {row.isValid ? (
                            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 hover:bg-emerald-500/20">
                              جاهز للاستيراد
                            </Badge>
                          ) : (
                            <Badge variant="destructive" className="text-[10px]">
                              {row.error}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0 pt-3 border-t">
          <Button type="button" variant="outline" onClick={handleResetAndClose} disabled={importMutation.isPending}>
            إلغاء
          </Button>
          <Button
            type="button"
            onClick={() => importMutation.mutate()}
            disabled={validCount === 0 || importMutation.isPending || isParsing}
            className="bg-blue-600 hover:bg-blue-700 text-white gap-2"
          >
            {importMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            إضافة {validCount} من المواد إلى العهدة
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
