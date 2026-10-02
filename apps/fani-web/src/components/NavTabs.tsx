import React from 'react';
import { Truck, Package } from 'lucide-react';

interface NavTabsProps {
  currentRoute: string;
}

export const NavTabs: React.FC<NavTabsProps> = ({ currentRoute }) => {
  const tabs = [
    { key: 'transfers', label: 'الشحنات والتحويلات', icon: Truck, hash: '#/transfers' },
    { key: 'products', label: 'منتجاتي وعهدتي', icon: Package, hash: '#/products' },
  ];

  return (
    <nav className="bg-white border-b border-slate-200 z-20 shadow-2xs">
      <div className="max-w-[1920px] mx-auto px-3 sm:px-6 flex items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = currentRoute === tab.key;
          const Icon = tab.icon;
          return (
            <a
              key={tab.key}
              href={tab.hash}
              className={`flex items-center gap-2 px-4 sm:px-5 py-3 text-xs font-black border-b-2 transition-all whitespace-nowrap ${
                isActive
                  ? 'border-[#0F5EA8] text-[#0F5EA8]'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
};
