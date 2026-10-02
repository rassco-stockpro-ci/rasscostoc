export interface User {
  id: string;
  username: string;
  name: string;
  role: string;
  employeeCode?: string;
  avatarUrl?: string;
}

export interface TransferItem {
  id: string;
  itemTypeId: string;
  itemTypeName: string;
  category: 'devices' | 'sim' | 'accessories';
  requestedQuantity: number;
  scannedQuantity: number;
  scannedSerials: string[];
}

export interface WarehouseTransfer {
  id: string;
  transferNumber: string;
  sourceWarehouseName: string;
  targetWarehouseName: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'PARTIAL';
  createdAt: string;
  items: TransferItem[];
}

class ApiClient {
  private baseUrl = '/api';

  private getHeaders(): Record<string, string> {
    const token = localStorage.getItem('fani_auth_token');
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async login(username: String, password: String): Promise<{ success: boolean; user?: User; message?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (data.token) {
          localStorage.setItem('fani_auth_token', data.token);
        }
        localStorage.setItem('fani_user', JSON.stringify(data.user || data.data));
        return { success: true, user: data.user || data.data };
      }
      return { success: false, message: data.message || 'فشل تسجيل الدخول' };
    } catch (err: any) {
      return { success: false, message: err.message || 'تعذر الاتصال بالخادم' };
    }
  }

  async getMe(): Promise<User | null> {
    try {
      const res = await fetch(`${this.baseUrl}/auth/me`, {
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.user || data;
    } catch {
      return null;
    }
  }

  logout() {
    localStorage.removeItem('fani_auth_token');
    localStorage.removeItem('fani_user');
  }

  async getTransfers(): Promise<any[]> {
    try {
      const res = await fetch(`${this.baseUrl}/warehouse-transfers`, {
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : (data.transfers || []);
    } catch {
      return [];
    }
  }

  async getTransferDetails(id: string): Promise<any | null> {
    try {
      const res = await fetch(`${this.baseUrl}/warehouse-transfers/${id}`, {
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        return data.transfer || data;
      }
    } catch {}

    // Fallback: search transfers list
    try {
      const list = await this.getTransfers();
      const found = list.find((t: any) => t.id === id);
      if (found) return found;
    } catch {}

    return null;
  }

  async acceptTransfer(id: string): Promise<{ success: boolean; message?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/warehouse-transfers/${id}/accept`, {
        method: 'POST',
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      const data = await res.json();
      if (res.ok) {
        return { success: true, message: data.message || 'تم تأكيد الاستلام بنجاح' };
      }
      return { success: false, message: data.message || 'فشل تأكيد الاستلام' };
    } catch (err: any) {
      return { success: false, message: err.message || 'خطأ أثناء الاتصال' };
    }
  }

  /**
   * Scan a single serial into a SPECIFIC warehouse transfer's receiving flow.
   * The server validates/derives the item type from the transfer record itself
   * (transfer.itemType) — this is the correct, transfer-scoped, documented
   * receiving path (POST /api/warehouse-transfers/:id/scan-serial), NOT the
   * generic /serialized-items/scan-in endpoint (which is unrelated to transfers).
   * Requires the transfer to already be in "accepted" status server-side.
   */
  async scanTransferSerial(transferId: string, serialNumber: string): Promise<{ success: boolean; message?: string; item?: any }> {
    try {
      const res = await fetch(`${this.baseUrl}/warehouse-transfers/${transferId}/scan-serial`, {
        method: 'POST',
        headers: this.getHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ serialNumber }),
      });
      const data = await res.json();
      if (res.ok && (data.success !== false)) {
        return { success: true, message: data.message || 'تم المسح والمطابقة بنجاح', item: data };
      }
      return { success: false, message: data.message || 'السيريال غير مطابق أو مكرر' };
    } catch (err: any) {
      return { success: false, message: err.message || 'خطأ في المسح' };
    }
  }

  /**
   * Finalize receiving a warehouse transfer: verifies the required quantity has been
   * scanned (for serialized item types) and correctly updates the technician's moving
   * inventory quantities + transfer status server-side. This is the real "documented
   * receipt from warehouse" step (POST /api/warehouse-transfers/:id/confirm-receipt).
   */
  async confirmTransferReceipt(transferId: string): Promise<{ success: boolean; message?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/warehouse-transfers/${transferId}/confirm-receipt`, {
        method: 'POST',
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        return { success: true, message: data.message || 'تم تأكيد الاستلام وتحديث المخزون بنجاح' };
      }
      return { success: false, message: data.message || 'فشل تأكيد الاستلام النهائي' };
    } catch (err: any) {
      return { success: false, message: err.message || 'خطأ أثناء تأكيد الاستلام' };
    }
  }

  async getTransferById(id: string): Promise<any | null> {
    return this.getTransferDetails(id);
  }

  async getItemTypes(): Promise<any[]> {
    try {
      const res = await fetch(`${this.baseUrl}/item-types/active`, {
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : (data.data || []);
    } catch {
      return [];
    }
  }

  async getMyCustody(): Promise<any[]> {
    try {
      const res = await fetch(`${this.baseUrl}/my-serialized-custody`, {
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : (data.data || []);
    } catch {
      return [];
    }
  }

  async lookupSerial(serialNumber: string): Promise<{ success: boolean; message?: string; data?: any }> {
    try {
      const res = await fetch(`${this.baseUrl}/serialized-items/lookup/${encodeURIComponent(serialNumber)}`, {
        headers: this.getHeaders(),
        cache: 'no-store',
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        return { success: true, data: data.data || data };
      }
      return { success: false, message: data.message || 'تعذر العثور على المادة' };
    } catch (err: any) {
      return { success: false, message: err.message || 'خطأ أثناء البحث' };
    }
  }

  async deleteCustodyItem(
    itemType: 'DEVICE' | 'SIM',
    identifier: string,
    confirmation: string,
    reason?: string
  ): Promise<{ success: boolean; message?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/inventory/my-custody/items/${itemType}/${encodeURIComponent(identifier)}`, {
        method: 'DELETE',
        headers: this.getHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ confirmation, reason }),
      });
      const data = await res.json();
      if (res.ok && data.success !== false) {
        return { success: true, message: 'تم حذف المادة من عهدتك بنجاح' };
      }
      return { success: false, message: data.message || 'فشل حذف المادة' };
    } catch (err: any) {
      return { success: false, message: err.message || 'خطأ أثناء الحذف' };
    }
  }

}

export const api = new ApiClient();
