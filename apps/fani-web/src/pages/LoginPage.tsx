import React, { useState } from 'react';
import { User, Lock, ArrowLeft, Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { api, User as UserType } from '../api/client';
import { RasscoLogo } from '../components/RasscoLogo';

interface LoginPageProps {
  onLoginSuccess: (user: UserType) => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('يرجى كتابة اسم المستخدم وكلمة المرور');
      return;
    }
    setLoading(true);
    setError(null);

    const result = await api.login(username.trim(), password.trim());
    setLoading(false);

    if (result.success && result.user) {
      onLoginSuccess(result.user);
    } else {
      setError(result.message || 'اسم المستخدم أو كلمة المرور غير صحيحة');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#F5F7FA] relative overflow-hidden">
      {/* Background Decorative Soft Touches */}
      <div className="absolute top-0 left-0 right-0 h-72 bg-gradient-to-b from-[#0F5EA8]/10 to-transparent pointer-events-none" />

      {/* Main RASSCO Enterprise White Card */}
      <div className="w-full max-w-md bg-white rounded-3xl p-8 sm:p-10 relative z-10 border border-slate-200 shadow-xl">

        {/* Official RASSCO Logo Header */}
        <div className="flex flex-col items-center text-center mb-8">
          <RasscoLogo size="xl" subtitle="بوابة الفنيين والمشرفين — تسجيل الدخول" lightMode={true} />
        </div>

        {/* Error Alert */}
        {error && (
          <div className="mb-6 p-4 rounded-2xl bg-rose-50 border border-rose-200 flex items-start gap-3 text-rose-700 text-sm">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1 font-semibold">{error}</div>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-xs font-extrabold text-slate-700 mb-2 mr-1">
              اسم المستخدم
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none text-[#0F5EA8]">
                <User className="w-5 h-5" />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="أدخل اسم المستخدم"
                className="w-full pl-4 pr-12 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 text-slate-900 placeholder-slate-400 text-sm font-semibold focus:bg-white focus:border-[#0F5EA8] focus:ring-4 focus:ring-[#0F5EA8]/15 outline-none transition-all"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-extrabold text-slate-700 mb-2 mr-1">
              كلمة المرور
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none text-[#0F5EA8]">
                <Lock className="w-5 h-5" />
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="أدخل كلمة المرور"
                className="w-full pl-4 pr-12 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 text-slate-900 placeholder-slate-400 text-sm font-semibold focus:bg-white focus:border-[#0F5EA8] focus:ring-4 focus:ring-[#0F5EA8]/15 outline-none transition-all"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-4 rounded-2xl rassco-btn-primary text-base flex items-center justify-center gap-2 group disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>جاري تسجيل الدخول...</span>
              </>
            ) : (
              <>
                <span>تسجيل الدخول</span>
                <ArrowLeft className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
              </>
            )}
          </button>
        </form>

        <div className="mt-8 text-center text-xs text-slate-500 border-t border-slate-100 pt-6 flex items-center justify-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#0F5EA8]" />
          <span>نظام RASSCO Enterprise ERP © 2026</span>
        </div>
      </div>
    </div>
  );
};
