import { createClient } from '@supabase/supabase-js';

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Check if Supabase is configured
const isSupabaseConfigured = SUPABASE_URL && SUPABASE_ANON_KEY;

let supabase = null;

if (isSupabaseConfigured) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Supabase client initialized');
} else {
    console.log('⚠️  Supabase not configured. Some features will be disabled.');
    console.log('   To enable, set SUPABASE_URL and SUPABASE_ANON_KEY in .env');
}

// ============================================
// Contacts
// ============================================

async function getContacts() {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        console.error('Failed to get contacts:', error.message);
        return [];
    }
    return data || [];
}

async function addContact(contact) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('contacts')
        .insert([{
            name: contact.name,
            phone: contact.phone,
        }])
        .select()
        .single();
    if (error) {
        console.error('Failed to add contact:', error.message);
        return null;
    }
    return data;
}

async function addContacts(contacts) {
    if (!supabase) return [];
    const rows = contacts.map(c => ({
        name: c.name,
        phone: c.phone,
    }));

    // Use upsert with onConflict to handle duplicates
    const { data, error } = await supabase
        .from('contacts')
        .upsert(rows, {
            onConflict: 'phone',
            ignoreDuplicates: true
        })
        .select();
    if (error) {
        console.error('Failed to add contacts:', error.message);
        return [];
    }
    return data || [];
}

async function getContactByPhone(phone) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .eq('phone', phone)
        .single();
    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
        console.error('Failed to get contact:', error.message);
    }
    return data;
}

async function updateContact(id, updates) {
    if (!supabase) return false;
    const { error } = await supabase
        .from('contacts')
        .update({
            name: updates.name,
            phone: updates.phone,
        })
        .eq('id', id);
    if (error) {
        console.error('Failed to update contact:', error.message);
        return false;
    }
    return true;
}

async function deleteContact(id) {
    if (!supabase) return false;
    const { error } = await supabase
        .from('contacts')
        .delete()
        .eq('id', id);
    if (error) {
        console.error('Failed to delete contact:', error.message);
        return false;
    }
    return true;
}

// ============================================
// Birthdays
// ============================================

async function getBirthdays() {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('birthdays')
        .select('*')
        .order('birthday', { ascending: true });
    if (error) {
        console.error('Failed to get birthdays:', error.message);
        return [];
    }
    return data || [];
}

async function addBirthday(birthday) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('birthdays')
        .insert([{
            name: birthday.name,
            phone: birthday.phone,
            birthday: birthday.birthday,
            gender: birthday.gender,
            relationship: birthday.relationship,
            custom_message: birthday.customMessage || null,
        }])
        .select()
        .single();
    if (error) {
        console.error('Failed to add birthday:', error.message);
        return null;
    }
    return data;
}

async function deleteBirthday(id) {
    if (!supabase) return false;
    const { error } = await supabase
        .from('birthdays')
        .delete()
        .eq('id', id);
    if (error) {
        console.error('Failed to delete birthday:', error.message);
        return false;
    }
    return true;
}

async function getBirthdaysByDate(monthDay) {
    if (!supabase) return [];
    // monthDay format: "MM-DD"
    const { data, error } = await supabase
        .from('birthdays')
        .select('*');
    if (error) {
        console.error('Failed to get birthdays by date:', error.message);
        return [];
    }
    // Filter in JS since we need to match MM-DD format
    return (data || []).filter(b => {
        const bday = new Date(b.birthday);
        const md = `${String(bday.getMonth() + 1).padStart(2, '0')}-${String(bday.getDate()).padStart(2, '0')}`;
        return md === monthDay;
    });
}

// ============================================
// Schedule (Message Queue)
// ============================================

async function getSchedule() {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('schedule')
        .select('*')
        .order('send_at', { ascending: true });
    if (error) {
        console.error('Failed to get schedule:', error.message);
        return [];
    }
    return data || [];
}

async function getPendingSchedule() {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('schedule')
        .select('*')
        .eq('status', 'pending')
        .order('send_at', { ascending: true });
    if (error) {
        console.error('Failed to get pending schedule:', error.message);
        return [];
    }
    return data || [];
}

async function addScheduleItems(items) {
    if (!supabase) return [];
    const rows = items.map(item => ({
        batch_id: item.batchId,
        recipient: item.recipient,
        caption: item.caption || null,
        media_url: item.mediaUrl || null,
        media_type: item.mediaType || null,
        send_at: item.sendAt,
        status: 'pending',
    }));
    const { data, error } = await supabase
        .from('schedule')
        .insert(rows)
        .select();
    if (error) {
        console.error('Failed to add schedule items:', error.message);
        return [];
    }
    return data || [];
}

async function updateScheduleStatus(id, status, error = null, sentAt = null) {
    if (!supabase) return false;
    const updates = { status };
    if (error) updates.error = error;
    if (sentAt) updates.sent_at = sentAt;

    const { error: updateError } = await supabase
        .from('schedule')
        .update(updates)
        .eq('id', id);
    if (updateError) {
        console.error('Failed to update schedule status:', updateError.message);
        return false;
    }
    return true;
}

async function clearFinishedSchedule() {
    if (!supabase) return 0;
    const { data, error } = await supabase
        .from('schedule')
        .delete()
        .or('status.eq.sent,status.eq.failed')
        .select();
    if (error) {
        console.error('Failed to clear finished schedule:', error.message);
        return 0;
    }
    return data?.length || 0;
}

async function getDueScheduleItems() {
    if (!supabase) return [];
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('schedule')
        .select('*')
        .eq('status', 'pending')
        .lte('send_at', now);
    if (error) {
        console.error('Failed to get due schedule items:', error.message);
        return [];
    }
    return data || [];
}

// ============================================
// Finances
// ============================================

async function addFinanceEntry(entry) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('finances')
        .insert([{
            date: entry.date,
            type: entry.type,
            amount: entry.amount,
            category: entry.category,
            description: entry.description,
        }])
        .select()
        .single();
    if (error) {
        console.error('Failed to add finance entry:', error.message);
        return null;
    }
    return data;
}

async function getFinancesSince(startDate) {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('finances')
        .select('*')
        .gte('date', startDate)
        .order('date', { ascending: false });
    if (error) {
        console.error('Failed to get finances:', error.message);
        return [];
    }
    return data || [];
}

// ============================================
// Exports
// ============================================

export {
    supabase,
    isSupabaseConfigured,
    // Contacts
    getContacts,
    addContact,
    addContacts,
    getContactByPhone,
    updateContact,
    deleteContact,
    // Birthdays
    getBirthdays,
    addBirthday,
    deleteBirthday,
    getBirthdaysByDate,
    // Schedule
    getSchedule,
    getPendingSchedule,
    addScheduleItems,
    updateScheduleStatus,
    clearFinishedSchedule,
    getDueScheduleItems,
    // Finances
    addFinanceEntry,
    getFinancesSince,
};
