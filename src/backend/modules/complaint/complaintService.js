/**
 * Complaints and Reports Management Service (إدارة الشكاوى والبلاغات)
 * 
 * Supports:
 * - Direct complaints from passenger / driver web apps.
 * - Auto-escalated low ratings (1-2 stars).
 * - Full status lifecycle: pending, investigating, resolved, action_taken, dismissed.
 * - Admin notes, disciplinary actions (warnings, points deductions, suspensions/blocks).
 * - Enterprise audit logging (AuditService) & PostgreSQL persistence.
 */

const db = require('../../db');
const auditService = require('../audit/auditService');

const VALID_STATUSES = ['pending', 'investigating', 'resolved', 'action_taken', 'dismissed'];

class ComplaintService {
    /**
     * Submit a new complaint or auto-escalated low rating report
     */
    async submitComplaint(data = {}, ip = '127.0.0.1') {
        const id = 'cmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 5);
        const createdAt = new Date().toISOString();

        const complaint = {
            id,
            complainantId: data.complainantId || data.userId || 'usr-anonymous',
            complainantName: data.complainantName || data.userName || 'مستخدم',
            complainantPhone: data.complainantPhone || data.userPhone || '',
            accusedId: data.accusedId || data.targetId || data.driverId || '',
            accusedName: data.accusedName || data.targetName || data.driverName || 'الكابتن',
            accusedPhone: data.accusedPhone || data.driverPhone || '',
            category: data.category || data.subject || 'أخرى',
            complaintText: data.complaintText || data.details || data.text || '',
            rideId: data.rideId || '',
            priority: data.priority || (data.category === 'تقييم سلبي منخفض' ? 'High' : 'Normal'),
            status: 'pending', // Default status: pending (قيد المراجعة)
            adminNotes: '',
            actionTaken: '',
            resolvedAt: null,
            createdAt
        };

        // 1. Add to In-Memory state
        if (!db.memoryState.complaints) db.memoryState.complaints = [];
        db.memoryState.complaints.unshift(complaint);

        // 2. Persist to PostgreSQL if connected
        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    INSERT INTO complaints (
                        id, user_id, user_name, target_id, target_name,
                        complainant_id, complainant_name, complainant_phone,
                        accused_id, accused_name, accused_phone,
                        category, subject, details, complaint_text,
                        status, priority, ride_id, created_at
                    ) VALUES (
                        $1, $2, $3, $4, $5,
                        $6, $7, $8,
                        $9, $10, $11,
                        $12, $13, $14, $15,
                        $16, $17, $18, NOW()
                    )
                `, [
                    complaint.id,
                    complaint.complainantId,
                    complaint.complainantName,
                    complaint.accusedId || null,
                    complaint.accusedName || null,
                    complaint.complainantId,
                    complaint.complainantName,
                    complaint.complainantPhone,
                    complaint.accusedId,
                    complaint.accusedName,
                    complaint.accusedPhone,
                    complaint.category,
                    complaint.category,
                    complaint.complaintText,
                    complaint.complaintText,
                    complaint.status,
                    complaint.priority,
                    complaint.rideId || null
                ]);
            } catch (err) {
                console.warn('[ComplaintService] PostgreSQL insert warning:', err.message);
            }
        }

        // 3. Save snapshot to state.json
        db.saveStateSnapshot();

        // 4. Record Audit Log if low rating or high priority
        try {
            await auditService.logAuditEvent({
                action: 'ComplaintSubmitted',
                entityType: 'Complaint',
                entityId: complaint.id,
                actor: complaint.complainantName + (complaint.complainantPhone ? ` (${complaint.complainantPhone})` : ''),
                details: {
                    id: complaint.id,
                    category: complaint.category,
                    accusedName: complaint.accusedName,
                    accusedPhone: complaint.accusedPhone,
                    summary: `تقديم بلاغ جديد: [${complaint.category}] ضد (${complaint.accusedName})`
                },
                ip
            });
        } catch (_) {}

        return { success: true, complaint };
    }

    /**
     * Get complaints with filtering & counters
     */
    async getComplaints(params = {}) {
        const { status, category, search, limit = 100, offset = 0 } = params;

        let list = [...(db.memoryState.complaints || [])];

        // Status counts across all complaints
        const counts = {
            total: list.length,
            pending: list.filter(c => c.status === 'pending' || c.status === 'Pending' || c.status === 'Open').length,
            investigating: list.filter(c => c.status === 'investigating').length,
            resolved: list.filter(c => c.status === 'resolved' || c.status === 'Resolved' || c.status === 'محلولة').length,
            action_taken: list.filter(c => c.status === 'action_taken').length,
            dismissed: list.filter(c => c.status === 'dismissed').length,
            low_rating: list.filter(c => c.category === 'تقييم سلبي منخفض').length
        };

        // Filter by Status
        if (status && status !== 'all') {
            if (status === 'pending') {
                list = list.filter(c => c.status === 'pending' || c.status === 'Pending' || c.status === 'Open');
            } else if (status === 'resolved') {
                list = list.filter(c => c.status === 'resolved' || c.status === 'Resolved' || c.status === 'محلولة');
            } else {
                list = list.filter(c => c.status === status);
            }
        }

        // Filter by Category
        if (category && category !== 'all') {
            if (category === 'low_rating') {
                list = list.filter(c => c.category === 'تقييم سلبي منخفض');
            } else {
                list = list.filter(c => c.category === category);
            }
        }

        // Filter by Search Query
        if (search && search.trim()) {
            const q = search.trim().toLowerCase();
            list = list.filter(c => {
                const cPhone = String(c.complainantPhone || '').toLowerCase();
                const aPhone = String(c.accusedPhone || '').toLowerCase();
                const cName = String(c.complainantName || '').toLowerCase();
                const aName = String(c.accusedName || '').toLowerCase();
                const cat = String(c.category || '').toLowerCase();
                const text = String(c.complaintText || c.details || '').toLowerCase();
                const id = String(c.id || '').toLowerCase();

                return cPhone.includes(q) || aPhone.includes(q) || cName.includes(q) || aName.includes(q) || cat.includes(q) || text.includes(q) || id.includes(q);
            });
        }

        const totalFiltered = list.length;
        const paged = list.slice(offset, offset + limit);

        return {
            success: true,
            total: totalFiltered,
            counts,
            complaints: paged
        };
    }

    /**
     * Resolve, investigate, or take disciplinary action on a complaint
     */
    async resolveComplaint(complaintId, updates = {}, actor = 'المشرف العام (Admin)', ip = '127.0.0.1') {
        const complaints = db.memoryState.complaints || [];
        const complaint = complaints.find(c => c.id === complaintId);
        if (!complaint) {
            return { success: false, error: 'الشكوى أو البلاغ غير موجود' };
        }

        const targetStatus = updates.status || 'resolved';
        if (!VALID_STATUSES.includes(targetStatus)) {
            return { success: false, error: `الحالة المطلوبة غير صالحة. الحالات المسموحة: ${VALID_STATUSES.join(', ')}` };
        }

        complaint.status = targetStatus;
        if (updates.adminNotes !== undefined) complaint.adminNotes = updates.adminNotes;
        if (updates.actionTaken !== undefined) complaint.actionTaken = updates.actionTaken;
        complaint.resolvedAt = new Date().toISOString();
        complaint.resolvedBy = actor;

        // Disciplinary action: Block accused driver if requested
        let driverActionLog = '';
        if (updates.blockDriver && complaint.accusedId) {
            const driver = db.findDriver(complaint.accusedId);
            if (driver) {
                driver.isBlocked = true;
                driver.status = 'Blocked';
                driverActionLog += ` | تم حظر الكابتن (${driver.fullName})`;
            }
        }

        // Disciplinary action: Deduct penalty points if requested
        if (updates.penaltyPoints && Number(updates.penaltyPoints) > 0 && complaint.accusedId) {
            const pts = Number(updates.penaltyPoints);
            const driver = db.findDriver(complaint.accusedId);
            if (driver) {
                driver.points = Math.max(0, (driver.points || 0) - pts);
                driverActionLog += ` | خصم ${pts} نقطة من الكابتن (${driver.fullName})`;
            }
        }

        // Update in PostgreSQL
        if (db.isPostgresConnected && db.pool) {
            try {
                await db.pool.query(`
                    UPDATE complaints 
                    SET status = $1, admin_notes = $2, action_taken = $3, resolved_at = NOW(), updated_at = NOW()
                    WHERE id = $4
                `, [complaint.status, complaint.adminNotes, complaint.actionTaken, complaint.id]);

                // Also update driver in PostgreSQL if blocked
                if (updates.blockDriver && complaint.accusedId) {
                    await db.pool.query(`
                        UPDATE drivers SET is_blocked = true, status = 'Blocked', updated_at = NOW()
                        WHERE driver_id = $1
                    `, [complaint.accusedId]).catch(() => {});
                }
            } catch (err) {
                console.warn('[ComplaintService] PostgreSQL update error:', err.message);
            }
        }

        db.saveStateSnapshot();

        // Audit Log
        try {
            await auditService.logAuditEvent({
                action: updates.actionTaken ? 'ComplaintActionTaken' : 'ComplaintResolved',
                entityType: 'Complaint',
                entityId: complaint.id,
                actor: actor || 'المشرف العام (Admin)',
                details: {
                    complaintId: complaint.id,
                    status: complaint.status,
                    category: complaint.category,
                    adminNotes: complaint.adminNotes,
                    actionTaken: complaint.actionTaken,
                    accusedName: complaint.accusedName,
                    accusedPhone: complaint.accusedPhone,
                    summary: `معالجة شكوى [${complaint.category}]: تغيير الحالة إلى (${complaint.status}) ${complaint.actionTaken ? 'واتخاذ إجراء: ' + complaint.actionTaken : ''}${driverActionLog}`
                },
                ip
            });
        } catch (_) {}

        return { success: true, complaint };
    }
}

module.exports = new ComplaintService();
