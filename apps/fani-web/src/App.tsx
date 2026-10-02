import React, { useState, useEffect } from 'react';
import { LoginPage } from './pages/LoginPage';
import { TransfersPage } from './pages/TransfersPage';
import { ShipmentScanPage } from './pages/ShipmentScanPage';
import { ProductsPage } from './pages/ProductsPage';
import { Header } from './components/Header';
import { NavTabs } from './components/NavTabs';
import { api, User } from './api/client';

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentRoute, setCurrentRoute] = useState<string>('transfers');
  const [activeTransferId, setActiveTransferId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  // Hash Router Listener & URL Permalinks
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash || '#/transfers';
      if (hash.startsWith('#/scan')) {
        const parts = hash.split('/');
        const id = parts[2];
        setActiveTransferId(id && id.trim().length > 0 ? id : null);
        setCurrentRoute('scan');
      } else if (hash.startsWith('#/products')) {
        setCurrentRoute('products');
        setActiveTransferId(null);
      } else {
        setCurrentRoute('transfers');
        setActiveTransferId(null);
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    // Verify session with API first — do NOT pre-load user from localStorage
    // to avoid showing a stale/expired session (e.g. old eissa11 session)
    const me = await api.getMe();
    if (me) {
      setUser(me);
      localStorage.setItem('fani_user', JSON.stringify(me));
    } else {
      // No valid session — clear any stale data
      localStorage.removeItem('fani_auth_token');
      localStorage.removeItem('fani_user');
      setUser(null);
    }
    setLoading(false);

    if (me) {
      const transfers = await api.getTransfers();
      if (transfers) {
        const p = transfers.filter((t: any) => t.status === 'pending' || t.status === 'PENDING').length;
        setPendingCount(p);
      }
    }
  };

  const handleLogout = () => {
    api.logout();
    localStorage.clear();
    sessionStorage.clear();
    setUser(null);
    window.location.hash = '#/login';
  };

  const handleOpenScan = (transferId?: string) => {
    if (transferId) {
      window.location.hash = `#/scan/${transferId}`;
    } else {
      window.location.hash = '#/scan';
    }
  };

  const handleBackToTransfers = () => {
    window.location.hash = '#/transfers';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col items-center justify-center text-slate-900 font-bold space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-[#0F5EA8] text-white flex items-center justify-center text-xl font-black shadow-md animate-bounce">
          R
        </div>
        <div className="text-sm font-extrabold text-[#0F5EA8] animate-pulse">
          StockPro Enterprise ERP — جاري تحميل بوابة الفنيين...
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLoginSuccess={(u) => { setUser(u); window.location.hash = '#/transfers'; }} />;
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col font-['Cairo'] text-slate-900 antialiased selection:bg-[#00A896] selection:text-white overflow-x-hidden">

      {/* 1. Sticky Top Navigation Header Bar */}
      <Header
        user={user}
        onLogout={handleLogout}
        onOpenNotifications={() => setIsNotificationsOpen(true)}
        pendingCount={pendingCount}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* 1.5 Section Nav Tabs (hidden on the scan station) */}
      {currentRoute !== 'scan' && <NavTabs currentRoute={currentRoute} />}

      {/* 2. Main Page Content Container */}
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1920px] w-full mx-auto">
        {currentRoute === 'scan' ? (
          <ShipmentScanPage
            transferId={activeTransferId}
            onBack={handleBackToTransfers}
          />
        ) : currentRoute === 'products' ? (
          <ProductsPage searchQuery={searchQuery} />
        ) : (
          <TransfersPage
            user={user}
            onLogout={handleLogout}
            onOpenScan={handleOpenScan}
            searchQuery={searchQuery}
            isNotificationsOpen={isNotificationsOpen}
            onCloseNotifications={() => setIsNotificationsOpen(false)}
          />
        )}
      </main>

    </div>
  );
};
