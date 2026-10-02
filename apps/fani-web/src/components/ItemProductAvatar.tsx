import React from 'react';
import {
  Smartphone,
  Cpu,
  Printer,
  BatteryCharging,
  Radio,
  CreditCard,
  Layers,
  Tag
} from 'lucide-react';

export interface ItemMetadata {
  key: string;
  name: string;
  nameEn: string;
  category: 'devices' | 'sim' | 'printer' | 'accessory';
  manufacturer: string;
  barcodeFormat: string;
  primaryColor: string;
  illustrationType: 'pax_a960' | 'i9100' | 'i9000s' | 'n950' | 'stc_sim' | 'mobily_sim' | 'zain_sim' | 'printer' | 'generic';
}

export const getItemMetadata = (itemTypeKey: string): ItemMetadata => {
  const key = (itemTypeKey || '').toLowerCase();

  if (key.includes('a960') || key.includes('960')) {
    return {
      key: 'A960',
      name: 'جهاز POS — PAX A960 Smart',
      nameEn: 'PAX A960 Smart POS',
      category: 'devices',
      manufacturer: 'PAX Technology',
      barcodeFormat: 'S/N (مثال: SN89201982)',
      primaryColor: '#0F5EA8',
      illustrationType: 'pax_a960',
    };
  }

  if (key.includes('i9100') || key.includes('9100')) {
    return {
      key: 'I9100',
      name: 'جهاز نقاط بيع — Urovo i9100',
      nameEn: 'Urovo i9100 Android POS',
      category: 'devices',
      manufacturer: 'Urovo',
      barcodeFormat: 'S/N (مثال: UR90019284)',
      primaryColor: '#00A896',
      illustrationType: 'i9100',
    };
  }

  if (key.includes('i9000') || key.includes('9000')) {
    return {
      key: 'I9000S',
      name: 'جهاز نقاط بيع — i9000S Terminal',
      nameEn: 'i9000S Smart POS',
      category: 'devices',
      manufacturer: 'Urovo',
      barcodeFormat: 'S/N (مثال: UR771092)',
      primaryColor: '#00A896',
      illustrationType: 'i9000s',
    };
  }

  if (key.includes('n950') || key.includes('950')) {
    return {
      key: 'N950',
      name: 'جهاز نقاط بيع — N950 Smart POS',
      nameEn: 'N950 Terminal',
      category: 'devices',
      manufacturer: 'Newland',
      barcodeFormat: 'S/N (مثال: NL991029)',
      primaryColor: '#00A896',
      illustrationType: 'n950',
    };
  }

  if (key.includes('stc') || key.includes('اتصالات')) {
    return {
      key: 'stcSim',
      name: 'شريحة اتصال STC — بيانات 5G / SIM',
      nameEn: 'STC 5G Data SIM',
      category: 'sim',
      manufacturer: 'STC Saudi Arabia',
      barcodeFormat: 'ICCID 19-20 Digits',
      primaryColor: '#7C3AED',
      illustrationType: 'stc_sim',
    };
  }

  if (key.includes('mobily') || key.includes('موبايلي')) {
    return {
      key: 'mobilySim',
      name: 'شريحة اتصال Mobily — بيانات Business',
      nameEn: 'Mobily Data SIM',
      category: 'sim',
      manufacturer: 'Mobily Saudi Arabia',
      barcodeFormat: 'ICCID 19 Digits',
      primaryColor: '#0284C7',
      illustrationType: 'mobily_sim',
    };
  }

  if (key.includes('zain') || key.includes('زين')) {
    return {
      key: 'zainSim',
      name: 'شريحة اتصال ZAIN — بيانات M2M',
      nameEn: 'Zain M2M SIM',
      category: 'sim',
      manufacturer: 'Zain Saudi Arabia',
      barcodeFormat: 'ICCID 19 Digits',
      primaryColor: '#16A34A',
      illustrationType: 'zain_sim',
    };
  }

  if (key.includes('sim') || key.includes('شريحة')) {
    return {
      key: 'genericSim',
      name: 'شريحة اتصال — 5G SIM Card',
      nameEn: 'Generic 5G SIM Card',
      category: 'sim',
      manufacturer: 'Telecom Operator',
      barcodeFormat: 'ICCID 19-20 Digits',
      primaryColor: '#7C3AED',
      illustrationType: 'stc_sim',
    };
  }

  // itemTypeKey may be an opaque database id (e.g. a UUID) rather than a
  // readable code — never surface a raw id as the product name.
  const looksLikeOpaqueId = /^[0-9a-f-]{16,}$/i.test(key);

  return {
    key: 'genericPos',
    name: (!looksLikeOpaqueId && itemTypeKey) || 'صنف غير مصنّف',
    nameEn: 'POS Hardware Equipment',
    category: 'devices',
    manufacturer: 'RASSCO Equipment',
    barcodeFormat: 'S/N Barcode',
    primaryColor: '#0F5EA8',
    illustrationType: 'pax_a960',
  };
};

interface ItemProductAvatarProps {
  itemTypeKey: string;
  /** Override the guessed display name — use when the real item type name is already
   * known from the API (e.g. itemTypeNameAr), since itemTypeKey may be an opaque
   * UUID that getItemMetadata() cannot recognize by keyword. */
  displayName?: string;
  /** Override the guessed category (devices/sim/...) when already known from the API. */
  displayCategory?: ItemMetadata['category'];
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  showSubtext?: boolean;
  showCategoryPill?: boolean;
  className?: string;
}

const categoryLabels: Record<ItemMetadata['category'], string> = {
  devices: 'أجهزة',
  sim: 'شرائح',
  printer: 'طابعات',
  accessory: 'ملحقات',
};

export const ItemProductAvatar: React.FC<ItemProductAvatarProps> = ({
  itemTypeKey,
  displayName,
  displayCategory,
  size = 'md',
  showSubtext = true,
  showCategoryPill = false,
  className = '',
}) => {
  // If itemTypeKey is an opaque id (e.g. a UUID) that doesn't match any known
  // product keyword, guessing from it alone would surface the raw id as the
  // "name". Prefer the caller-supplied real name/category when given.
  const guessed = getItemMetadata(itemTypeKey);
  const meta: ItemMetadata = {
    ...guessed,
    name: displayName || guessed.name,
    category: displayCategory || guessed.category,
  };

  const sizeMap = {
    xs: { box: 'w-8 h-8 rounded-lg', icon: 'w-4 h-4', title: 'text-xs', sub: 'hidden' },
    sm: { box: 'w-10 h-10 rounded-xl', icon: 'w-5 h-5', title: 'text-xs', sub: 'text-[10px]' },
    md: { box: 'w-12 h-12 rounded-xl', icon: 'w-6 h-6', title: 'text-xs font-bold', sub: 'text-[11px]' },
    lg: { box: 'w-16 h-16 rounded-2xl', icon: 'w-8 h-8', title: 'text-sm font-extrabold', sub: 'text-xs' },
    xl: { box: 'w-24 h-24 rounded-2xl', icon: 'w-12 h-12', title: 'text-base font-black', sub: 'text-xs' },
  };

  const dim = sizeMap[size] || sizeMap.md;

  // Realistic Clean Product Thumbnail Graphic Render
  const renderProductGraphic = () => {
    switch (meta.illustrationType) {
      case 'pax_a960':
      case 'i9100':
      case 'i9000s':
      case 'n950':
        return (
          <div className="w-full h-full rounded-xl bg-slate-100 border border-slate-200 flex flex-col items-center justify-center p-1 relative overflow-hidden shadow-2xs">
            {/* POS Device Screen */}
            <div className="w-4/5 h-2/3 rounded-lg bg-gradient-to-b from-[#0F5EA8] to-slate-900 p-1 flex flex-col items-center justify-between border border-slate-300">
              <div className="w-full flex items-center justify-between">
                <span className="w-1 h-1 rounded-full bg-emerald-400" />
                <span className="text-[7px] font-mono text-cyan-300">PAY</span>
              </div>
              <CreditCard className="w-3 h-3 text-white/90" />
            </div>
            {/* Thermal Printer Paper Roll & Keypad base */}
            <div className="w-3/4 h-1 bg-slate-400 rounded-full mt-1" />
          </div>
        );

      case 'stc_sim':
      case 'mobily_sim':
      case 'zain_sim':
        return (
          <div className="w-full h-full rounded-xl bg-purple-50 border border-purple-200 flex flex-col items-center justify-center p-1 relative overflow-hidden shadow-2xs">
            <span className="text-[8px] font-black text-purple-700 tracking-wider">STC</span>
            <div className="w-4 h-3 bg-amber-400 rounded-xs border border-amber-600 my-0.5" />
            <span className="text-[6px] font-bold text-slate-500">5G SIM</span>
          </div>
        );

      default:
        return (
          <div className="w-full h-full rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center p-1 shadow-2xs">
            <Smartphone className={`${dim.icon} text-[#0F5EA8]`} />
          </div>
        );
    }
  };

  return (
    <div className={`flex items-center gap-3 min-w-0 ${className}`}>
      {/* Product Image Thumbnail */}
      <div className={`${dim.box} shrink-0`}>
        {renderProductGraphic()}
      </div>

      {/* Product Text Details */}
      <div className="flex flex-col text-right min-w-0 flex-1">
        {showCategoryPill && (
          <span className="self-start px-2 py-0.5 mb-1 rounded-full bg-slate-100 text-slate-600 text-[9px] font-black w-fit">
            {categoryLabels[meta.category]}
          </span>
        )}
        <span className={`${dim.title} text-slate-900 leading-tight truncate`}>{meta.name}</span>
        {showSubtext && (
          <span className={`${dim.sub} text-slate-500 font-semibold mt-0.5`}>
            {meta.category === 'sim' ? 'شرائح اتصال (5G / M2M)' : `${meta.manufacturer} (Android)`}
          </span>
        )}
      </div>
    </div>
  );
};
