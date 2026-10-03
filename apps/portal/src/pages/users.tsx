import { useTranslation } from "@/lib/language";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Search, Plus, Edit, Trash2, Users as UsersIcon, Home, ArrowRight, Sparkles, UserCircle, UserCheck, UserX } from "lucide-react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import type { UserSafe } from "@shared/schema";
import { TelegramLinkStatus } from "@/components/telegram-link-status";
import { ROLE_BADGE_VARIANTS, getRoleLabel } from "@shared/roles";
import { useToast } from "@/hooks/use-toast";
import { AddUserModal } from "@/components/add-user-modal";
import { EditUserModal } from "@/components/edit-user-modal";
import rasscoLogo from "@assets/39bff80c-2b7d-48a8-80ed-34b372af4da3_transparent_1762470013152.png";
import neoleapLogo from "@assets/image_1762469922998.png";
import madaDevice from "@assets/image_1762469811135.png";

export default function UsersPage() {

  const { t, dir } = useTranslation();
  const [, setLocation] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserSafe | null>(null);
  const { toast } = useToast();

  const { data: users, isLoading } = useQuery<UserSafe[]>({
    queryKey: ["/api/users"],
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({
        title: t('users.completed_delete_successfully'),
        description: t('users.completed_delete_user'),
      });
    },
    onError: () => {
      toast({
        title: t('users.error'),
        description: t('users.fail_delete_user'),
        variant: "destructive",
      });
    },
  });

  const bulkStatusMutation = useMutation({
    mutationFn: async (isActive: boolean) => {
      const res = await apiRequest("POST", "/api/users/bulk-status", { isActive });
      return res.json();
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({
        title: t('users.operation_successfully'),
        description: variables 
          ? t('users.completed_users_successfully', { var_0: data.count }) 
          : t('users.completed_users_successfully_1', { var_0: data.count }),
      });
    },
    onError: () => {
      toast({
        title: t('users.error'),
        description: t('users.fail_update_status_users'),
        variant: "destructive",
      });
    },
  });

  const handleEdit = (user: UserSafe) => {
    setSelectedUser(user);
    setShowEditModal(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm(t('users.delete_2'))) {
      deleteUserMutation.mutate(id);
    }
  };

  const filteredUsers = users?.filter(
    (user) =>
      user.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.username.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      user.city?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
        <motion.div 
          className="text-center"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
        >
          <motion.div 
            className="relative w-24 h-24 mx-auto mb-6"
            animate={{ rotate: 360 }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
          >
            <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-500 border-r-purple-500"></div>
            <div className="absolute inset-2 rounded-full border-4 border-transparent border-b-pink-500 border-l-cyan-500"></div>
          </motion.div>
          <p className="text-white text-lg font-semibold">{t('users.loading_1')}</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900" dir={dir}>
      {/* Animated Banner */}
      <div className="relative overflow-hidden bg-gradient-to-r from-cyan-500 via-blue-600 to-purple-600 shadow-2xl">
        <div className="absolute inset-0 bg-grid-white/5"></div>
        
        <motion.div
          className="absolute top-0 left-0 w-72 h-72 bg-blue-500/30 rounded-full blur-3xl"
          animate={{
            x: [0, 100, 0],
            y: [0, 50, 0],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />
        <motion.div
          className="absolute bottom-0 right-0 w-96 h-96 bg-purple-500/30 rounded-full blur-3xl"
          animate={{
            x: [0, -100, 0],
            y: [0, -50, 0],
          }}
          transition={{
            duration: 10,
            repeat: Infinity,
            ease: "easeInOut"
          }}
        />

        <div className="relative container mx-auto px-4 py-8">
          <motion.div
            className="mb-4"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
          >
            <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
              <Button
                onClick={() => setLocation('/')}
                className="bg-white/95 hover:bg-white text-blue-600 font-bold shadow-xl border-2 border-white/50"
                data-testid="button-back-home"
              >
                <Home className="w-5 h-5 ml-2" />
                {t('users.page_home')}
                <ArrowRight className="w-5 h-5 mr-2" />
              </Button>
            </motion.div>
          </motion.div>

          <div className="flex flex-col lg:flex-row items-center justify-between gap-8">
            <motion.div 
              className="flex items-center gap-8"
              initial={{ opacity: 0, x: -50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8 }}
            >
              <motion.div
                className="bg-white/95 backdrop-blur-sm rounded-2xl p-4 shadow-2xl cursor-pointer"
                whileHover={{ scale: 1.05, rotate: 2 }}
                transition={{ type: "spring", stiffness: 300 }}
                onClick={() => {
                  setLocation("/courier");
                }}
              >
                <img src={rasscoLogo} alt="RASSCO" className="h-16 w-auto" />
              </motion.div>
              
              <motion.div
                className="bg-white/95 backdrop-blur-sm rounded-2xl p-4 shadow-2xl"
                whileHover={{ scale: 1.05, rotate: -2 }}
                transition={{ type: "spring", stiffness: 300 }}
              >
                <img src={neoleapLogo} alt="Neoleap" className="h-16 w-auto" />
              </motion.div>
            </motion.div>

            <motion.div 
              className="text-center flex-1"
              initial={{ opacity: 0, y: -30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
            >
              <motion.div
                animate={{ 
                  scale: [1, 1.02, 1],
                }}
                transition={{ 
                  duration: 2,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
              >
                <h1 className="text-4xl lg:text-5xl font-black text-white mb-2 drop-shadow-2xl flex items-center justify-center gap-3">
                  <Sparkles className="h-10 w-10 text-yellow-300 animate-pulse" />
                  {t('users.management_users')}
                  <Sparkles className="h-10 w-10 text-yellow-300 animate-pulse" />
                </h1>
                <p className="text-white/90 text-lg font-semibold">{t('users.add_system')}</p>
              </motion.div>
            </motion.div>

            <motion.div
              className="relative"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.4 }}
            >
              <motion.div
                animate={{ 
                  y: [0, -10, 0],
                }}
                transition={{ 
                  duration: 3,
                  repeat: Infinity,
                  ease: "easeInOut"
                }}
                className="relative"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-cyan-400 to-purple-500 rounded-3xl blur-xl opacity-50"></div>
                <img src={madaDevice} alt="MADA Device" className="h-48 w-auto relative z-10 drop-shadow-2xl" />
              </motion.div>
            </motion.div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0">
          <svg viewBox="0 0 1200 120" preserveAspectRatio="none" className="w-full h-12 fill-slate-900">
            <path d="M321.39,56.44c58-10.79,114.16-30.13,172-41.86,82.39-16.72,168.19-17.73,250.45-.39C823.78,31,906.67,72,985.66,92.83c70.05,18.48,146.53,26.09,214.34,3V0H0V27.35A600.21,600.21,0,0,0,321.39,56.44Z"></path>
          </svg>
        </div>
      </div>

      <div className="container mx-auto p-4 sm:p-6 space-y-6">
        {/* Search and Add Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="flex flex-col lg:flex-row gap-4 items-stretch lg:items-center justify-between"
        >
          <div className="relative flex-1 max-w-md">
            <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 h-5 w-5" />
            <Input
              type="text"
              placeholder={t('users.item_19252')}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pr-10 bg-white dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-600 h-12"
              data-testid="input-search"
            />
          </div>
          
          <div className="flex flex-col sm:flex-row flex-wrap gap-3 items-stretch sm:items-center justify-end">
            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="flex-1 sm:flex-initial">
              <Button
                onClick={() => {
                  if (confirm(t('users.item_51185'))) {
                    bulkStatusMutation.mutate(true);
                  }
                }}
                disabled={bulkStatusMutation.isPending}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold shadow-lg h-12 px-5 flex items-center justify-center gap-2 border-2 border-emerald-500/20"
                data-testid="button-activate-all"
              >
                <UserCheck className="h-5 w-5" />
                {t('users.users')}
              </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="flex-1 sm:flex-initial">
              <Button
                onClick={() => {
                  if (confirm(t('users.item_84836'))) {
                    bulkStatusMutation.mutate(false);
                  }
                }}
                disabled={bulkStatusMutation.isPending}
                className="w-full bg-rose-600 hover:bg-rose-700 text-white font-bold shadow-lg h-12 px-5 flex items-center justify-center gap-2 border-2 border-rose-500/20"
                data-testid="button-deactivate-all"
              >
                <UserX className="h-5 w-5" />
                {t('users.users_1')}
              </Button>
            </motion.div>

            <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="flex-1 sm:flex-initial">
              <Button
                onClick={() => setShowAddModal(true)}
                className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white font-bold shadow-lg h-12 px-6 flex items-center justify-center gap-2"
                data-testid="button-add-user"
              >
                <Plus className="h-5 w-5" />
                {t('users.add_new')}
              </Button>
            </motion.div>
          </div>
        </motion.div>

        {/* Users Grid */}
        {filteredUsers && filteredUsers.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredUsers.map((user, index) => (
              <motion.div
                key={user.id}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, delay: index * 0.05 }}
                whileHover={{ y: -8, scale: 1.03 }}
              >
                <Card className="bg-white dark:bg-slate-800 border-0 shadow-2xl overflow-hidden relative">
                  {/* Profile Image Header */}
                  <div className="relative h-32 bg-gradient-to-br from-blue-500 via-purple-600 to-pink-500">
                    <div className="absolute inset-0 bg-black/20"></div>
                    <div className="absolute top-3 left-3 flex gap-2">
                      <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEdit(user)}
                          className="h-9 w-9 bg-white/90 hover:bg-white text-blue-600 shadow-lg backdrop-blur-sm"
                          data-testid={`button-edit-${user.id}`}
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                      </motion.div>
                      <motion.div whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(user.id)}
                          className="h-9 w-9 bg-white/90 hover:bg-white text-red-600 shadow-lg backdrop-blur-sm"
                          data-testid={`button-delete-${user.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </motion.div>
                    </div>
                  </div>
                  
                  {/* Profile Avatar - Overlapping */}
                  <div className="relative -mt-16 flex justify-center px-6">
                    <motion.div
                      whileHover={{ scale: 1.1, rotate: 5 }}
                      className="relative"
                    >
                      <Avatar key={user.profileImage || user.id} className="h-32 w-32 border-[6px] border-white dark:border-slate-800 shadow-2xl ring-4 ring-blue-100 dark:ring-blue-900">
                        <AvatarImage 
                          src={user.profileImage || undefined} 
                          alt={user.fullName}
                          className="object-cover"
                        />
                        <AvatarFallback className="bg-gradient-to-br from-blue-500 to-purple-600 text-white font-black text-3xl">
                          {getInitials(user.fullName)}
                        </AvatarFallback>
                      </Avatar>
                      {user.isActive && (
                        <motion.div 
                          className="absolute bottom-2 right-2 w-6 h-6 bg-green-500 rounded-full border-4 border-white dark:border-slate-800 shadow-lg"
                          animate={{ scale: [1, 1.2, 1] }}
                          transition={{ duration: 2, repeat: Infinity }}
                        ></motion.div>
                      )}
                    </motion.div>
                  </div>

                  <CardContent className="pt-4 pb-6 space-y-4 text-center">
                    {/* User Info */}
                    <div>
                      <h3 className="font-black text-xl text-slate-800 dark:text-white mb-1">
                        {user.fullName}
                      </h3>
                      <p className="text-sm text-slate-600 dark:text-slate-400 font-medium">
                        @{user.username}
                      </p>
                    </div>

                    {/* Contact Info */}
                    <div className="space-y-2 bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3">
                      <div className="flex items-center justify-center gap-2 text-sm">
                        <span className="text-slate-600 dark:text-slate-400">📧</span>
                        <span className="text-slate-700 dark:text-slate-300 font-medium truncate">
                          {user.email}
                        </span>
                      </div>
                      {user.city && (
                        <div className="flex items-center justify-center gap-2 text-sm">
                          <span className="text-slate-600 dark:text-slate-400">📍</span>
                          <span className="text-slate-700 dark:text-slate-300 font-medium">
                            {user.city}
                          </span>
                        </div>
                      )}
                      {/* Telegram Linking Status */}
                      <div className="pt-1 flex items-center justify-center border-t border-slate-200/60 dark:border-slate-800">
                        {user.telegramUserId ? (
                          <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 rounded-lg text-xs font-semibold border border-sky-200 dark:border-sky-800">
                            <svg className="w-3.5 h-3.5 fill-current text-sky-500" viewBox="0 0 24 24">
                              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.02-1.96 1.25-5.54 3.69-.52.36-1 .53-1.42.52-.47-.01-1.37-.26-2.03-.48-.82-.27-1.47-.42-1.42-.88.03-.24.38-.49 1.05-.75 4.12-1.79 6.87-2.97 8.25-3.55 3.93-1.64 4.74-1.93 5.27-1.94.12 0 .38.03.55.17.14.12.18.28.2.46-.01.06.01.24 0 .36z" />
                            </svg>
                            <span className="font-mono">{user.telegramUserId}</span>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleEdit(user)}
                            className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 hover:bg-amber-100 rounded-lg text-xs font-semibold border border-amber-200 dark:border-amber-800 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5 fill-current text-amber-500" viewBox="0 0 24 24">
                              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.02-1.96 1.25-5.54 3.69-.52.36-1 .53-1.42.52-.47-.01-1.37-.26-2.03-.48-.82-.27-1.47-.42-1.42-.88.03-.24.38-.49 1.05-.75 4.12-1.79 6.87-2.97 8.25-3.55 3.93-1.64 4.74-1.93 5.27-1.94.12 0 .38.03.55.17.14.12.18.28.2.46-.01.06.01.24 0 .36z" />
                            </svg>
                            <span>+ ربط حساب التليجرام</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {user.telegramUserId && <TelegramLinkStatus user={user as any} />}

                    {/* Enterprise Details */}
                    {(user.employeeCode || user.technicianCode || user.department) && (
                      <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1 bg-slate-50/50 dark:bg-slate-900/30 rounded-xl p-3 text-right" dir={dir}>
                        {user.department && (
                          <div className="flex justify-between">
                            <span className="text-slate-400">{t('users.item_8031')}</span>
                            <span className="font-semibold text-slate-700 dark:text-slate-300">{user.department}</span>
                          </div>
                        )}
                        {user.employeeCode && (
                          <div className="flex justify-between">
                            <span className="text-slate-400">{t('users.number_7')}</span>
                            <span className="font-semibold text-slate-700 dark:text-slate-300">{user.employeeCode}</span>
                          </div>
                        )}
                        {user.technicianCode && (
                          <div className="flex justify-between">
                            <span className="text-slate-400">{t('users.number_technician')}</span>
                            <span className="font-semibold text-slate-700 dark:text-slate-300">{user.technicianCode}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Permissions Mini Badges */}
                    {user.permissions && (
                      <div className="flex flex-wrap gap-1 justify-center pt-1">
                        {(() => {
                          try {
                            const perms = typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions;
                            if (Array.isArray(perms) && perms.length > 0) {
                              return perms.map((perm: string) => (
                                <span key={perm} className="text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700">
                                  {perm}
                                </span>
                              ));
                            }
                          } catch (e) {}
                          return null;
                        })()}
                      </div>
                    )}

                    {/* Badges */}
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      <motion.span 
                        whileHover={{ scale: 1.05 }}
                        className={`inline-flex items-center px-4 py-2 rounded-full text-sm font-bold shadow-sm border
                        ${ROLE_BADGE_VARIANTS[user.role as keyof typeof ROLE_BADGE_VARIANTS] || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                        {getRoleLabel(user.role)}
                      </motion.span>
                      <motion.span 
                        whileHover={{ scale: 1.05 }}
                        className={`inline-flex items-center px-4 py-2 rounded-full text-sm font-bold
                        ${user.isActive 
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 shadow-md' 
                          : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 shadow-md'}`}>
                        {user.isActive ? t('users.status_active_symbol') : t('users.status_inactive_symbol')}
                      </motion.span>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-16"
          >
            <Card className="max-w-md mx-auto bg-white dark:bg-slate-800 border-0 shadow-2xl">
              <CardContent className="py-12">
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 200 }}
                >
                  <UserCircle className="h-24 w-24 mx-auto mb-6 text-slate-400" />
                </motion.div>
                <h3 className="text-2xl font-bold mb-3 text-slate-800 dark:text-white">
                  {searchTerm ? t('users.no_results') : t('users.no_3')}
                </h3>
                <p className="text-slate-600 dark:text-slate-400 mb-6">
                  {searchTerm 
                    ? t('users.item_35152') 
                    : t('users.item_36736')}
                </p>
                {!searchTerm && (
                  <Button 
                    onClick={() => setShowAddModal(true)} 
                    className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
                  >
                    <Plus className="h-5 w-5 ml-2" />
                    {t('users.add_1')}
                  </Button>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </div>

      <AddUserModal open={showAddModal} onOpenChange={setShowAddModal} />
      <EditUserModal 
        open={showEditModal} 
        onOpenChange={setShowEditModal}
        user={selectedUser}
      />
    </div>
  );
}

