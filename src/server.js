import 'dotenv/config';
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { nanoid } from "nanoid";
import helmet from "helmet";
import compression from "compression";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Colombo");

import logger from './services/logger.js';
import * as db from './services/database.js';
import { initBaileys, getSocket, getConnectionStatus, isConnectingStatus, getUptime, startBaileys, updateSettings } from './services/baileys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
	cors: {
		origin: process.env.NODE_ENV === 'production' ? false : '*',
		methods: ['GET', 'POST']
	}
});

const PORT = process.env.PORT || 3000;

// Security and performance middleware
app.use(helmet({
	contentSecurityPolicy: false, // Disable CSP for inline scripts
	crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		const dir = path.join(__dirname, "..", "public", "uploads");
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		cb(null, dir);
	},
	filename: (req, file, cb) => {
		const ext = path.extname(file.originalname) || ".tmp";
		cb(null, `${Date.now()}-${nanoid()}${ext}`);
	}
});
const upload = multer({ storage });

// Health check endpoint
app.get("/api/health", (req, res) => {
	res.status(200).json({
		status: "ok",
		timestamp: new Date().toISOString(),
		uptime: getUptime(),
		whatsapp: getConnectionStatus().connected ? "connected" : "disconnected"
	});
});

// API routes
app.get("/api/status", (req, res) => {
	res.json({
		status: getConnectionStatus(),
		isConnecting: isConnectingStatus(),
		uptime: getUptime()
	});
});

app.get("/api/uptime", (req, res) => {
	res.json({
		uptime: getUptime(),
		connected: getConnectionStatus().connected
	});
});

app.post("/api/bot/connect", (req, res) => {
	startBaileys(io, true);
	res.json({ success: true, message: "Connecting..." });
});

app.post("/api/bot/disconnect", async (req, res) => {
	const sock = getSocket();
	if (sock) {
		await sock.logout();
	}
	res.json({ success: true, message: "Disconnected" });
});

app.get("/api/settings", (req, res) => {
	res.json({
		autoViewStatus: process.env.AUTO_VIEW_STATUS !== "false",
		autoReactStatus: process.env.AUTO_REACT_STATUS === "true",
		reactionEmoji: process.env.REACTION_EMOJI || "❤️,💕,😍,👍",
		lastSeenUpdatedAt: getUptime()
	});
});

app.post("/api/settings", (req, res) => {
	const { autoViewStatus, autoReactStatus, reactionEmoji } = req.body;

	if (typeof autoViewStatus !== 'undefined') {
		process.env.AUTO_VIEW_STATUS = String(autoViewStatus);
	}
	if (typeof autoReactStatus !== 'undefined') {
		process.env.AUTO_REACT_STATUS = String(autoReactStatus);
	}
	if (typeof reactionEmoji !== 'undefined') {
		process.env.REACTION_EMOJI = reactionEmoji;
	}

	const newSettings = {
		autoViewStatus: process.env.AUTO_VIEW_STATUS !== "false",
		autoReactStatus: process.env.AUTO_REACT_STATUS === "true",
		reactionEmoji: process.env.REACTION_EMOJI
	};

	updateSettings(newSettings);
	io.emit("settings:update", newSettings);

	res.json({ success: true, message: "Settings updated" });
});

app.post("/api/schedule", upload.single("media"), async (req, res) => {
	try {
		const { recipients, caption, sendAt } = req.body;
		if (!recipients) {
			return res.status(400).json({ error: "Recipients are required" });
		}

		const recipientList = recipients.split(",").map(r => r.trim()).filter(r => r);
		if (recipientList.length === 0) {
			return res.status(400).json({ error: "Invalid recipients list" });
		}

		const batchId = nanoid();
		const sendAtDate = sendAt ? dayjs(sendAt).toISOString() : dayjs().add(2, 'second').toISOString();

		const items = recipientList.map(recipient => ({
			batchId,
			recipient,
			caption: caption || null,
			mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
			mediaType: req.file ? req.file.mimetype : null,
			sendAt: sendAtDate,
		}));

		const newRows = await db.addScheduleItems(items);

		io.emit("queue:scheduled", newRows);

		res.json({
			success: true,
			batchId,
			created: recipientList.length,
			message: `Scheduled ${recipientList.length} message(s) successfully`
		});
	} catch (e) {
		logger.error({ err: e }, "Failed to schedule message");
		res.status(500).json({ error: "Failed to schedule message" });
	}
});

app.get("/api/schedule", async (req, res) => {
	try {
		const schedule = await db.getSchedule();
		const mapped = schedule.map(row => ({
			id: row.id,
			batchId: row.batch_id,
			recipient: row.recipient,
			caption: row.caption,
			mediaUrl: row.media_url,
			mediaType: row.media_type,
			sendAt: row.send_at,
			status: row.status,
			error: row.error,
			sentAt: row.sent_at,
		}));
		res.json(mapped);
	} catch (e) {
		logger.error({ err: e }, "Failed to get schedule");
		res.status(500).json({ error: "Failed to retrieve schedule" });
	}
});

app.post("/api/schedule/clear", async (req, res) => {
	try {
		const count = await db.clearFinishedSchedule();
		res.json({ success: true, message: `Cleared ${count} finished jobs.` });
	} catch (e) {
		logger.error({ err: e }, "Failed to clear schedule");
		res.status(500).json({ error: "Failed to clear schedule" });
	}
});

app.get("/api/contacts", async (req, res) => {
	try {
		const contacts = await db.getContacts();
		res.json(contacts.map(c => ({
			id: c.id,
			name: c.name,
			phone: c.phone,
		})));
	} catch (e) {
		logger.error({ err: e }, "Failed to get contacts");
		res.status(500).json({ error: "Failed to retrieve contacts" });
	}
});

app.put("/api/contacts/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const { name, phone } = req.body;
		if (!name || !phone) {
			return res.status(400).json({ error: "Name and phone are required" });
		}
		const success = await db.updateContact(id, { name, phone });
		if (success) {
			res.json({ success: true, message: "Contact updated" });
		} else {
			res.status(404).json({ error: "Contact not found" });
		}
	} catch (e) {
		logger.error({ err: e }, "Failed to update contact");
		res.status(500).json({ error: "Failed to update contact" });
	}
});

app.delete("/api/contacts/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const success = await db.deleteContact(id);
		if (success) {
			res.json({ success: true, message: "Contact deleted" });
		} else {
			res.status(404).json({ error: "Contact not found" });
		}
	} catch (e) {
		logger.error({ err: e }, "Failed to delete contact");
		res.status(500).json({ error: "Failed to delete contact" });
	}
});

app.post("/api/contacts", async (req, res) => {
	try {
		const { name, phone } = req.body;
		if (!name || !phone) {
			return res.status(400).json({ error: "Name and phone are required" });
		}
		const contact = await db.addContact({ name, phone });
		if (contact) {
			res.json({ success: true, contact });
		} else {
			res.status(500).json({ error: "Failed to add contact" });
		}
	} catch (e) {
		logger.error({ err: e }, "Failed to add contact");
		res.status(500).json({ error: "Failed to add contact" });
	}
});

// ============================================
// Groups API
// ============================================

app.get("/api/groups", async (req, res) => {
	try {
		const sock = getSocket();
		if (!sock || !getConnectionStatus().connected) {
			return res.status(503).json({ error: "WhatsApp not connected" });
		}

		const groups = await sock.groupFetchAllParticipating();
		const groupList = Object.values(groups).map(group => ({
			id: group.id,
			name: group.subject,
			owner: group.owner || group.subjectOwner,
			participants: group.participants?.length || 0,
			creation: group.creation,
			desc: group.desc,
		}));

		// Sort by name
		groupList.sort((a, b) => a.name.localeCompare(b.name));
		res.json(groupList);
	} catch (e) {
		logger.error({ err: e }, "Failed to fetch groups");
		res.status(500).json({ error: "Failed to fetch groups" });
	}
});

app.get("/api/groups/:id", async (req, res) => {
	try {
		const sock = getSocket();
		if (!sock || !getConnectionStatus().connected) {
			return res.status(503).json({ error: "WhatsApp not connected" });
		}

		const { id } = req.params;
		const metadata = await sock.groupMetadata(id);
		res.json({
			id: metadata.id,
			name: metadata.subject,
			owner: metadata.owner,
			participants: metadata.participants,
			creation: metadata.creation,
			desc: metadata.desc,
		});
	} catch (e) {
		logger.error({ err: e }, "Failed to fetch group metadata");
		res.status(500).json({ error: "Failed to fetch group metadata" });
	}
});

app.post("/api/groups/:id/send", upload.single("media"), async (req, res) => {
	try {
		const sock = getSocket();
		if (!sock || !getConnectionStatus().connected) {
			return res.status(503).json({ error: "WhatsApp not connected" });
		}

		const { id } = req.params;
		const { message, sendAt } = req.body;

		if (!message && !req.file) {
			return res.status(400).json({ error: "Message or media is required" });
		}

		// If scheduled, add to schedule queue
		if (sendAt) {
			const scheduleItem = {
				batchId: nanoid(),
				recipient: id,
				caption: message || "",
				mediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
				mediaType: req.file ? (req.file.mimetype.startsWith("image") ? "image" : "video") : null,
				sendAt: dayjs(sendAt).toISOString(),
			};

			await db.addScheduleItems([scheduleItem]);
			res.json({ success: true, message: "Message scheduled for group" });
		} else {
			// Send immediately
			if (req.file) {
				const buf = await fsp.readFile(req.file.path);
				const isImage = req.file.mimetype.startsWith("image");

				await sock.sendMessage(id, {
					[isImage ? "image" : "video"]: buf,
					caption: message || undefined,
				});

				// Clean up uploaded file
				await fsp.unlink(req.file.path);
			} else {
				await sock.sendMessage(id, { text: message });
			}

			res.json({ success: true, message: "Message sent to group" });
		}
	} catch (e) {
		logger.error({ err: e }, "Failed to send to group");
		res.status(500).json({ error: "Failed to send message to group" });
	}
});

// Create a new group
app.post("/api/groups/create", async (req, res) => {
	try {
		const sock = getSocket();
		if (!sock || !getConnectionStatus().connected) {
			return res.status(503).json({ error: "WhatsApp not connected" });
		}

		const { name, participants } = req.body;

		if (!name) {
			return res.status(400).json({ error: "Group name is required" });
		}

		// Participants should be an array of phone numbers (with country code)
		const participantJids = (participants || []).map(p => {
			const phone = p.replace(/[^0-9]/g, '');
			return `${phone}@s.whatsapp.net`;
		});

		const group = await sock.groupCreate(name, participantJids);

		res.json({
			success: true,
			message: "Group created successfully",
			group: {
				id: group.id,
				name: group.subject
			}
		});
	} catch (e) {
		logger.error({ err: e }, "Failed to create group");
		res.status(500).json({ error: e?.message || "Failed to create group" });
	}
});

// Add members to a group
app.post("/api/groups/:id/participants/add", async (req, res) => {
	try {
		const sock = getSocket();
		if (!sock || !getConnectionStatus().connected) {
			return res.status(503).json({ error: "WhatsApp not connected" });
		}

		const { id } = req.params;
		const { participants } = req.body;

		if (!participants || !Array.isArray(participants) || participants.length === 0) {
			return res.status(400).json({ error: "Participants array is required" });
		}

		const participantJids = participants.map(p => {
			const phone = p.replace(/[^0-9]/g, '');
			return `${phone}@s.whatsapp.net`;
		});

		const result = await sock.groupParticipantsUpdate(id, participantJids, "add");

		res.json({
			success: true,
			message: `Added ${participantJids.length} member(s) to group`,
			result
		});
	} catch (e) {
		logger.error({ err: e }, "Failed to add members to group");
		res.status(500).json({ error: e?.message || "Failed to add members" });
	}
});

// Remove members from a group
app.post("/api/groups/:id/participants/remove", async (req, res) => {
	try {
		const sock = getSocket();
		if (!sock || !getConnectionStatus().connected) {
			return res.status(503).json({ error: "WhatsApp not connected" });
		}

		const { id } = req.params;
		const { participants } = req.body;

		if (!participants || !Array.isArray(participants) || participants.length === 0) {
			return res.status(400).json({ error: "Participants array is required" });
		}

		// Participants can be JIDs or phone numbers
		const participantJids = participants.map(p => {
			if (p.includes('@')) return p; // Already a JID
			const phone = p.replace(/[^0-9]/g, '');
			return `${phone}@s.whatsapp.net`;
		});

		const result = await sock.groupParticipantsUpdate(id, participantJids, "remove");

		res.json({
			success: true,
			message: `Removed ${participantJids.length} member(s) from group`,
			result
		});
	} catch (e) {
		logger.error({ err: e }, "Failed to remove members from group");
		res.status(500).json({ error: e?.message || "Failed to remove members" });
	}
});

// Get group participants
app.get("/api/groups/:id/participants", async (req, res) => {
	try {
		const sock = getSocket();
		if (!sock || !getConnectionStatus().connected) {
			return res.status(503).json({ error: "WhatsApp not connected" });
		}

		const { id } = req.params;
		const metadata = await sock.groupMetadata(id);

		const participants = metadata.participants.map(p => {
			// Handle both phone JIDs (xxx@s.whatsapp.net) and LIDs (xxx@lid)
			const jid = p.id;
			let phone = jid.split('@')[0];
			let isLid = jid.endsWith('@lid');

			// Remove device suffix if present (e.g., "94726051310:40" -> "94726051310")
			if (phone.includes(':')) {
				phone = phone.split(':')[0];
			}

			return {
				id: p.id,
				phone: phone,
				isLid: isLid,
				displayName: isLid ? `LID: ${phone.substring(0, 6)}...` : phone,
				admin: p.admin || null,
				isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
			};
		});

		res.json(participants);
	} catch (e) {
		logger.error({ err: e }, "Failed to get group participants");
		res.status(500).json({ error: "Failed to get group participants" });
	}
});

app.post("/api/contacts/import-vcf", upload.single("vcf"), async (req, res) => {
	if (!req.file) {
		return res.status(400).json({ error: "VCF file is required." });
	}
	try {
		const vcfData = await fsp.readFile(req.file.path, "utf-8");
		const lines = vcfData.split(/\r\n|\r|\n/);

		const contacts = [];
		let currentContact = {};

		for (const line of lines) {
			if (line.startsWith("BEGIN:VCARD")) {
				currentContact = {};
			} else if (line.startsWith("END:VCARD")) {
				if (currentContact.name && currentContact.phone) {
					contacts.push(currentContact);
				}
			} else if (line.startsWith("FN:")) {
				currentContact.name = line.substring(3).trim();
			} else if (line.startsWith("TEL;")) {
				currentContact.phone = line.split(":").pop().replace(/[^\d+]/g, "").trim();
			}
		}

		if (contacts.length > 0) {
			// Check for existing phones
			const existingContacts = await db.getContacts();
			const existingPhones = new Set(existingContacts.map(c => c.phone));
			const newContacts = contacts.filter(c => !existingPhones.has(c.phone));

			if (newContacts.length > 0) {
				await db.addContacts(newContacts);
				res.json({ success: true, message: `Imported ${newContacts.length} new contacts.` });
			} else {
				res.json({ success: true, message: "No new contacts to import." });
			}
		} else {
			res.status(400).json({ error: "No contacts found in VCF file." });
		}
	} catch (e) {
		logger.error({ err: e }, "Failed to import VCF");
		res.status(500).json({ error: "Failed to process VCF file." });
	} finally {
		await fsp.unlink(req.file.path);
	}
});

app.get("/api/contacts/export-csv", async (req, res) => {
	try {
		const contacts = await db.getContacts();
		if (contacts.length === 0) {
			return res.status(404).send("No contacts to export.");
		}

		const headers = ['id', 'name', 'phone', 'created_at'];
		const csvRows = [headers.join(',')];

		for (const contact of contacts) {
			const values = headers.map(header => {
				const value = String(contact[header] || '');
				const escaped = value.replace(/"/g, '""');
				if (escaped.includes(',')) {
					return `"${escaped}"`;
				}
				return escaped;
			});
			csvRows.push(values.join(','));
		}

		res.setHeader('Content-Type', 'text/csv');
		res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
		res.status(200).end(csvRows.join('\n'));

	} catch (e) {
		logger.error({ err: e }, "Failed to export contacts to CSV");
		res.status(500).send("Failed to export contacts.");
	}
});

app.get("/api/birthdays", async (req, res) => {
	try {
		const birthdays = await db.getBirthdays();
		res.json(birthdays.map(b => ({
			id: b.id,
			name: b.name,
			phone: b.phone,
			birthday: b.birthday,
		})));
	} catch (e) {
		logger.error({ err: e }, "Failed to get birthdays");
		res.status(500).json({ error: "Failed to retrieve birthdays" });
	}
});

app.post("/api/birthdays", async (req, res) => {
	try {
		const { name, phone, birthday, gender, relationship, customMessage } = req.body;

		if (!name || !phone || !birthday || !gender || !relationship) {
			return res.status(400).json({ error: "Missing required fields: name, phone, birthday, gender, relationship" });
		}

		if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
			return res.status(400).json({ error: "Birthday must be in YYYY-MM-DD format" });
		}

		if (!['male', 'female'].includes(gender.toLowerCase())) {
			return res.status(400).json({ error: "Gender must be 'male' or 'female'" });
		}

		const validRelationships = ['friend', 'family', 'relative', 'other'];
		if (!validRelationships.includes(relationship.toLowerCase())) {
			return res.status(400).json({ error: "Invalid relationship" });
		}

		const newBirthday = await db.addBirthday({
			name,
			phone,
			birthday,
			gender: gender.toLowerCase(),
			relationship: relationship.toLowerCase(),
			customMessage: customMessage || null,
		});

		if (!newBirthday) {
			return res.status(500).json({ error: "Failed to add birthday" });
		}

		logger.info("Added birthday:", newBirthday);
		res.json({ success: true, birthday: newBirthday });
	} catch (e) {
		logger.error({ err: e }, "Failed to add birthday");
		res.status(500).json({ error: "Failed to add birthday" });
	}
});

app.delete("/api/birthdays/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const success = await db.deleteBirthday(id);
		if (success) {
			res.json({ success: true, message: "Birthday deleted" });
		} else {
			res.status(404).json({ error: "Birthday not found" });
		}
	} catch (e) {
		logger.error({ err: e }, "Failed to delete birthday");
		res.status(500).json({ error: "Failed to delete birthday" });
	}
});

app.post("/api/birthdays/preview-message", async (req, res) => {
	try {
		const { name, gender, relationship } = req.body;
		if (!name || !gender || !relationship) {
			return res.status(400).json({ error: "Name, gender, and relationship are required." });
		}
		const message = `Happy birthday, ${name}! Wishing you all the best.`;
		res.json({ success: true, message });
	} catch (e) {
		logger.error({ err: e }, "Failed to preview birthday message");
		res.status(500).json({ error: "Failed to generate preview" });
	}
});


// Socket.IO connection
io.on("connection", (socket) => {
	logger.info("New client connected:", socket.id);

	socket.emit("connection:init", {
		status: getConnectionStatus(),
		isConnecting: isConnectingStatus(),
		queueSize: 0 // Placeholder
	});

	socket.on("disconnect", () => {
		logger.info("Client disconnected:", socket.id);
	});
});

// Initialize Baileys connection
initBaileys(io);

server.listen(PORT, () => {
	logger.info(`Server running on http://localhost:${PORT}`);
});