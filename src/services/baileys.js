import 'dotenv/config';
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import mime from "mime-types";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import fetch from 'node-fetch';
import { GoogleGenAI } from "@google/genai";
import makeWASocket, { fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser, useMultiFileAuthState } from "@whiskeysockets/baileys";

import logger from './logger.js';
import * as db from './database.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Colombo");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const statusCacheFile = path.join(DATA_DIR, "status-cache.json");

let sock = null;
let connectionStatus = { connected: false, lastDisconnect: null, qr: null, device: "Personal Bot" };
let sendingInProgress = false;
let autoViewStatus = process.env.AUTO_VIEW_STATUS !== "false";
let autoReactStatus = process.env.AUTO_REACT_STATUS === "true";
let reactionEmoji = process.env.REACTION_EMOJI || "🩵,🧡,💙,💚,💛,❤️";
let freezeLastSeen = true;
let lastSeenUpdatedAt = null;
let isConnecting = false;
let startTime = Date.now();
let userSelections = {};

let genAI = null;

export function updateSettings(newSettings) {
	if (typeof newSettings.autoViewStatus !== 'undefined') {
		autoViewStatus = newSettings.autoViewStatus;
	}
	if (typeof newSettings.autoReactStatus !== 'undefined') {
		autoReactStatus = newSettings.autoReactStatus;
	}
	if (typeof newSettings.reactionEmoji !== 'undefined') {
		reactionEmoji = newSettings.reactionEmoji;
	}
	logger.info('Bot settings updated:', { autoViewStatus, autoReactStatus, reactionEmoji });
}

function initializeGemini() {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		if (genAI) { // only log once
			logger.warn("No Gemini API key found in .env file, disabling AI features.");
			genAI = null;
		}
		return;
	}
	genAI = new GoogleGenAI(apiKey);
	logger.info(`Initialized Gemini AI.`);
}

function handleGeminiError(error) {
	logger.error({ err: error }, "An error occurred with the Gemini AI API.");
}

async function readJson(file, fallback) {
	try {
		const raw = await fsp.readFile(file, "utf-8");
		return JSON.parse(raw);
	} catch (e) {
		return fallback;
	}
}

async function writeJson(file, data) {
	await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

export async function startBaileys(io, clearAuth = false) {
	const authDir = path.join(DATA_DIR, "auth");
	if (clearAuth) {
		try {
			await fsp.rm(authDir, { recursive: true, force: true });
		} catch (e) {
			logger.warn("Failed to clear auth folder:", e.message);
		}
	}

	isConnecting = true;
	const { state, saveCreds } = await useMultiFileAuthState(authDir);
	const { version } = await fetchLatestBaileysVersion();

	sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: false,
		auth: state,
		markOnlineOnConnect: !freezeLastSeen,
		browser: ["Personal Bot", "Chrome", "1.0"],
	});

	sock.ev.on("creds.update", saveCreds);

	sock.ev.on("connection.update", async (update) => {
		const { connection, lastDisconnect, qr } = update;
		if (qr) {
			connectionStatus.qr = await QRCode.toDataURL(qr);
			io.emit("qr", { qr: connectionStatus.qr });
		}
		if (connection === "open") {
			connectionStatus.connected = true;
			connectionStatus.qr = null;
			isConnecting = false;
			io.emit("connection:update", { connected: true });
			logger.info("Baileys connected");
			try {
				if (freezeLastSeen && typeof sock.sendPresenceUpdate === "function") {
					await sock.sendPresenceUpdate("unavailable");
				}
			} catch { }
		}
		if (connection === "close") {
			connectionStatus.connected = false;
			connectionStatus.lastDisconnect = lastDisconnect?.error?.message || String(lastDisconnect?.error || "disconnected");
			isConnecting = false;
			io.emit("connection:update", { connected: false, reason: connectionStatus.lastDisconnect });
			const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
			if (shouldReconnect) {
				logger.warn("Reconnecting Baileys...");
				setTimeout(() => startBaileys(io, false), 2000);
			} else {
				logger.error("Logged out; delete auth folder to re-pair.");
			}
		}
	});

	sock.ev.on("messages.upsert", async (m) => {
		try {
			const msg = m.messages?.[0];
			if (!msg) return;
			const from = msg.key?.remoteJid || "";
			const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

			// Handle movie selection reply
			if (userSelections[from] && userSelections[from].type === 'movie' && /^[1-3]$/.test(messageText.trim())) {
				const selectionIndex = parseInt(messageText.trim(), 10) - 1;
				const searchResults = userSelections[from].results;

				if (selectionIndex >= 0 && selectionIndex < searchResults.length) {
					const selectedMovie = searchResults[selectionIndex];
					const response = `🎬 Here is the link for ${selectedMovie.title}:\nhttps://vidsrc.cc/v3/embed/movie/${selectedMovie.id}?autoPlay=false`;
					await sock.sendMessage(from, { text: response });
					delete userSelections[from];
				} else {
					// This case should not be reached due to regex, but as a fallback.
					await sock.sendMessage(from, { text: "Invalid selection. Please send a number from 1 to 3." });
				}
				return; // Stop further processing
			}

			// Handle TV show selection conversation
			if (userSelections[from] && userSelections[from].type === 'tv') {
				const selection = messageText.trim();
				const currentState = userSelections[from];
				const isNumeric = /^\d+$/.test(selection);

				// Only process numeric replies to avoid loops from the bot's own messages.
				if (!isNumeric) {
					return; // Not a numeric reply, so ignore it.
				}

				try {
					if (currentState.step === 'show_selection') {
						const selectionIndex = parseInt(selection, 10) - 1;
						if (selectionIndex >= 0 && selectionIndex < currentState.results.length) {
							const selectedShow = currentState.results[selectionIndex];

							// Fetch show details to get season list
							const detailsUrl = `https://api.themoviedb.org/3/tv/${selectedShow.id}?api_key=${process.env.TMDB_API_KEY}`;
							const detailsResponse = await fetch(detailsUrl);
							const showDetails = await detailsResponse.json();

							userSelections[from] = {
								...currentState,
								step: 'season_selection',
								selectedShow: showDetails,
							};

							let seasonList = `You selected *${showDetails.name}*. Please select a season:\n\n`;
							showDetails.seasons.forEach(season => {
								if (season.season_number === 0 && (season.name === "Specials" || season.name === "Extras")) return;
								seasonList += `*Season ${season.season_number}* (${season.episode_count} episodes)\n`;
							});
							seasonList += "\nPlease reply with the season number you want.";
							await sock.sendMessage(from, { text: seasonList });
						} else {
							await sock.sendMessage(from, { text: "Invalid selection. Please send a number from 1 to 3." });
						}

					} else if (currentState.step === 'season_selection') {
						const seasonNumber = parseInt(selection, 10);
						const seasonExists = currentState.selectedShow.seasons.some(s => s.season_number === seasonNumber);

						if (seasonExists) {
							// Fetch season details to get episode list
							const seasonDetailsUrl = `https://api.themoviedb.org/3/tv/${currentState.selectedShow.id}/season/${seasonNumber}?api_key=${process.env.TMDB_API_KEY}`;
							const seasonDetailsResponse = await fetch(seasonDetailsUrl);
							const seasonDetails = await seasonDetailsResponse.json();

							userSelections[from] = {
								...currentState,
								step: 'episode_selection',
								selectedSeason: seasonDetails,
							};

							let episodeList = `You selected *Season ${seasonNumber}*. Please select an episode:\n\n`;
							seasonDetails.episodes.forEach(ep => {
								episodeList += `*${ep.episode_number}. ${ep.name}*\n`;
							});
							episodeList += "\nPlease reply with the episode number you want.";
							await sock.sendMessage(from, { text: episodeList });

						} else {
							await sock.sendMessage(from, { text: "Invalid season number. Please try again." });
						}

					} else if (currentState.step === 'episode_selection') {
						const episodeNumber = parseInt(selection, 10);
						const episodeExists = currentState.selectedSeason.episodes.some(e => e.episode_number === episodeNumber);

						if (episodeExists) {
							const showId = currentState.selectedShow.id;
							const seasonNum = currentState.selectedSeason.season_number;
							const link = `📺 Here is your link:\nhttps://vidsrc.cc/v3/embed/tv/${showId}?s=${seasonNum}&e=${episodeNumber}`;
							await sock.sendMessage(from, { text: link });
							delete userSelections[from]; // End of conversation
						} else {
							await sock.sendMessage(from, { text: "Invalid episode number. Please try again." });
						}
					}
				} catch (e) {
					logger.error({ err: e }, "Failed during TV show selection process");
					await sock.sendMessage(from, { text: "❌ An error occurred. Please start over." });
					delete userSelections[from];
				}
				return; // Stop further processing
			}

			if (msg.key?.fromMe && from !== "status@broadcast") {
				if (messageText.startsWith(".")) {
					await handleCommand(msg, messageText);
					return;
				}
			}

			// Generate and emit smart replies
			if (!msg.key?.fromMe && (msg.message?.conversation || msg.message?.extendedTextMessage?.text)) {
				const suggestions = await generateReplySuggestions(messageText);
				io.emit("ai:reply-suggestions", { suggestions });
			}

			if (from !== "status@broadcast") return;
			const statuses = await readJson(statusCacheFile, []);
			const item = {
				id: msg.key?.id || nanoid(),
				timestamp: msg.messageTimestamp?.toString?.() || String(Date.now()),
				author: msg.key?.participant || "unknown",
				type: Object.keys(msg.message || {})[0] || "unknown",
				text: msg.message?.extendedTextMessage?.text || msg.message?.conversation || null,
				hasMedia: Boolean(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage),
			};
			statuses.unshift(item);
			while (statuses.length > 100) statuses.pop();
			await writeJson(statusCacheFile, statuses);
			io.emit("statuses:update", item);

			if (autoViewStatus && msg.key?.id && msg.key?.participant) {
				try {
					if (typeof sock.readMessages === "function") {
						await sock.readMessages([msg.key]);
					}
				} catch { }
				try {
				} catch { }

				const statusId = msg.key.id;
				const author = msg.key.participant;
				let viewed = false;
				let error = null;
				try {
					if (typeof sock.statusSubscribe === "function" && author) {
						await sock.statusSubscribe(author);
					}
					await new Promise(r => setTimeout(r, 1200));
					const normAuthor = author ? jidNormalizedUser(author) : author;
					if (typeof sock.readMessages === "function") {
						await sock.readMessages([{ chat: "status@broadcast", id: statusId, participant: normAuthor }]);
						viewed = true;
					} else if (typeof sock.sendReadReceipt === "function") {
						await sock.sendReadReceipt("status@broadcast", normAuthor, [statusId]);
						viewed = true;
					}
					if (!viewed && typeof sock.sendReceipt === "function") {
						await sock.sendReceipt("status@broadcast", normAuthor, [statusId], "read");
						viewed = true;
					}
					if (viewed && autoReactStatus && reactionEmoji) {
						try {
							let selectedEmoji = reactionEmoji;
							if (reactionEmoji.includes(',')) {
								const emojis = reactionEmoji.split(',').map(e => e.trim()).filter(e => e);
								if (emojis.length > 0) {
									selectedEmoji = emojis[Math.floor(Math.random() * emojis.length)];
								}
							}

							await sock.sendMessage(jidNormalizedUser(author), {
								react: {
									text: selectedEmoji,
									key: msg.key
								}
							});
							logger.info(`Reacted with ${selectedEmoji} to status from ${author}`);
						} catch (reactErr) {
							logger.warn({ err: reactErr }, "Failed to react to status");
						}
					}
				} catch (viewErr) {
					error = viewErr?.message || String(viewErr);
					logger.warn({ err: viewErr }, "Failed to auto-view status");
				}
				try {
					if (freezeLastSeen && typeof sock.sendPresenceUpdate === "function") {
						await sock.sendPresenceUpdate("available");
						await new Promise(r => setTimeout(r, 800));
						await sock.sendPresenceUpdate("unavailable");
						lastSeenUpdatedAt = new Date().toISOString();
						io.emit("presence:lastSeen", { lastSeenUpdatedAt });
					}
				} catch { }
				io.emit("statuses:viewed", { id: statusId, author, viewed, error });
			}
		} catch (e) {
			logger.error({ err: e }, "Failed to cache status message");
		}
	});
}

async function generateReplySuggestions(message) {
	if (!genAI) return [];
	try {
		const model = genAI.getGenerativeModel({ model: "gemini-pro" });
		const prompt = `Generate 2-3 short, context-aware reply suggestions for the following message:\n\n"${message}"\n\nSuggestions should be enclosed in double quotes and separated by a newline.`;
		const result = await model.generateContent(prompt);
		const response = await result.response;
		const text = response.text();
		const suggestions = text.match(/"(.*?)"/g).map(s => s.replace(/"/g, ''));
		return suggestions;
	} catch (error) {
		logger.error({ err: error }, "Failed to generate reply suggestions with AI");
		handleGeminiError(error);
		return [];
	}
}

async function handleCommand(msg, commandText) {
	try {
		const chatId = msg.key?.remoteJid;
		if (!chatId || !sock) return;

		const command = commandText.toLowerCase().trim();
		let response = "";

		const parts = command.split(" ");
		const cmd = parts[0];
		const args = parts.slice(1);

		switch (cmd) {
			case ".help":
				response = `🤖 *WaSender Bot Commands*

*Basic Commands:*
.help, .status, .time, .uptime

*Other Commands:*
.schedule, .birthdays, .logs, .restart, .disconnect`;
				break;

			case ".status":
				const isConnected = connectionStatus.connected;
				const geminiStatus = genAI ? "✅ Active" : "❌ Inactive";
				response = `🤖 *Bot Status*

Connection: ${isConnected ? "✅ Connected" : "❌ Disconnected"}
Gemini AI: ${geminiStatus}
Uptime: ${getUptime()}
Last Seen: ${lastSeenUpdatedAt || "Never"}`;
				break;

			case ".time":
				const now = dayjs.tz(undefined, "Asia/Colombo");
				response = `🕐 *Current Time* 

Sri Lanka Time: ${now.format("YYYY-MM-DD HH:mm:ss")}
UTC Time: ${now.utc().format("YYYY-MM-DD HH:mm:ss")}
Timezone: Asia/Colombo (UTC+5:30)`;
				break;

			case ".uptime":
				response = `⏱️ *Bot Uptime* 

${getUptime()}`;
				break;

			case ".schedule":
				if (args[0] === "list") {
					const schedule = await readJson(scheduleFile, []);
					const pending = schedule.filter(s => s.status === "pending");
					if (pending.length === 0) {
						response = "📅 No pending scheduled messages";
					} else {
						response = `📅 *Pending Messages (${pending.length})*\n\n`;
						pending.slice(0, 10).forEach((item, i) => {
							const time = dayjs(item.sendAt).tz("Asia/Colombo").format("MM-DD HH:mm");
							response += `${i + 1}. ${item.recipient}\n   📝 ${item.text?.substring(0, 50) || item.caption?.substring(0, 50) || "Media"}...\n   ⏰ ${time}\n\n`;
						});
						if (pending.length > 10) {
							response += `... and ${pending.length - 10} more`;
						}
					}
				} else if (args[0] === "clear") {
					const schedule = await readJson(scheduleFile, []);
					const cleared = schedule.filter(s => s.status !== "pending");
					await writeJson(scheduleFile, cleared);
					response = `🗑️ Cleared ${schedule.length - cleared.length} pending messages`;
				} else if (args[0] === "count") {
					const schedule = await readJson(scheduleFile, []);
					const pending = schedule.filter(s => s.status === "pending");
					response = `📊 *Schedule Statistics*

Pending: ${pending.length}
Completed: ${schedule.filter(s => s.status === "sent").length}
Failed: ${schedule.filter(s => s.status === "failed").length}
Total: ${schedule.length}`;
				} else {
					response = "❓ Usage: .schedule [list|clear|count]";
				}
				break;

			case ".birthdays":
				if (args[0] === "list") {
					const birthdays = await readJson(birthdaysFile, []);
					if (birthdays.length === 0) {
						response = "🎂 No birthdays stored";
					} else {
						response = `🎂 *Birthdays (${birthdays.length})*\n\n`;
						birthdays.forEach((bday, i) => {
							const bdayDate = dayjs(bday.birthday).format("MM-DD");
							response += `${i + 1}. ${bday.name} (${bday.phone})\n   📅 ${bdayDate} - ${bday.gender} ${bday.relationship}\n\n`;
						});
					}
				} else if (args[0] === "today") {
					const birthdays = await readJson(birthdaysFile, []);
					const today = dayjs.tz(undefined, "Asia/Colombo").format('MM-DD');
					const todayBirthdays = birthdays.filter(b => b.birthday.includes(today));
					if (todayBirthdays.length === 0) {
						response = "🎂 No birthdays today";
					} else {
						response = `🎂 *Today's Birthdays (${todayBirthdays.length})*\n\n`;
						todayBirthdays.forEach((bday, i) => {
							response += `${i + 1}. ${bday.name} (${bday.phone})\n   ${bday.gender} ${bday.relationship}\n\n`;
						});
					}
				} else if (args[0] === "count") {
					const birthdays = await readJson(birthdaysFile, []);
					const today = dayjs.tz(undefined, "Asia/Colombo").format('MM-DD');
					const todayBirthdays = birthdays.filter(b => b.birthday.includes(today));
					response = `📊 *Birthday Statistics*

Total Birthdays: ${birthdays.length}
Today's Birthdays: ${todayBirthdays.length}
Family: ${birthdays.filter(b => b.relationship === 'family').length}
Relatives: ${birthdays.filter(b => b.relationship === 'relative').length}
Friends: ${birthdays.filter(b => b.relationship === 'friend').length}`;
				} else {
					response = "❓ Usage: .birthdays [list|today|count]";
				}
				break;

			case ".logs":
				response = `📋 *Recent Logs* 

Connection Status: ${connectionStatus.connected ? "Connected" : "Disconnected"}
Last Error: ${connectionStatus.lastError || "None"}
QR Code: ${connectionStatus.qr ? "Available" : "Not available"}`;
				break;

			case ".restart":
				response = "🔄 Restarting bot connection...";
				setTimeout(async () => {
					try {
						if (sock) await sock.logout();
						await startBaileys(true);
					} catch (e) {
						logger.error("Failed to restart:", e);
					}
				}, 1000);
				break;

			case ".disconnect":
				response = "🔌 Disconnecting bot...";
				setTimeout(async () => {
					try {
						if (sock) await sock.logout();
						connectionStatus.connected = false;
						connectionStatus.qr = null;
						sock = null;
					} catch (e) {
						logger.error("Failed to disconnect:", e);
					}
				}, 1000);
				break;

			case ".movie":
				const movieName = args.join(" ");
				if (!movieName) {
					response = "❓ Please provide a movie name. Usage: .movie <movie_name>";
				} else {
					const tmdbApiKey = process.env.TMDB_API_KEY;
					if (!tmdbApiKey) {
						response = "❌ TMDB API key is not set. Please add it to your .env file.";
					} else {
						try {
							const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&query=${encodeURIComponent(movieName)}`;
							console.log(`TMDB Search URL: ${searchUrl}`);
							const tmdbResponse = await fetch(searchUrl);
							const tmdbData = await tmdbResponse.json();
							console.log('TMDB Response:', JSON.stringify(tmdbData, null, 2));
							if (tmdbData.results && tmdbData.results.length > 0) {
								const top3Movies = tmdbData.results.slice(0, 3);
								userSelections[chatId] = {
									type: 'movie',
									results: top3Movies
								};

								let movieList = "🎬 Here are the top 3 results:\n\n";
								top3Movies.forEach((movie, index) => {
									movieList += `*${index + 1}. ${movie.title}* (${movie.release_date?.substring(0, 4) || 'N/A'})\n`;
									movieList += `⭐ Rating: ${movie.vote_average.toFixed(1)}/10\n`;
									movieList += `📝 Plot: ${movie.overview}\n\n`;
								});

								movieList += "Please reply with the number of the movie you want.";

								await sock.sendMessage(chatId, { text: movieList });
							} else {
								response = `😕 Could not find a movie with the name "${movieName}".`;
							}
						} catch (e) {
							logger.error({ err: e }, "Failed to fetch movie from TMDB");
							response = "❌ An error occurred while fetching movie information.";
						}
					}
				}
				break;

			case ".tv":
				const showName = args.join(" ");
				if (!showName) {
					response = "❓ Please provide a TV show name. Usage: .tv <show_name>";
				} else {
					const tmdbApiKey = process.env.TMDB_API_KEY;
					if (!tmdbApiKey) {
						response = "❌ TMDB API key is not set. Please add it to your .env file.";
					} else {
						try {
							const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${tmdbApiKey}&query=${encodeURIComponent(showName)}`;
							const tmdbResponse = await fetch(searchUrl);
							const tmdbData = await tmdbResponse.json();

							if (tmdbData.results && tmdbData.results.length > 0) {
								const top3Shows = tmdbData.results.slice(0, 3);
								userSelections[chatId] = {
									type: 'tv',
									step: 'show_selection',
									results: top3Shows
								};

								let showList = "📺 Here are the top 3 results:\n\n";
								top3Shows.forEach((show, index) => {
									showList += `*${index + 1}. ${show.name}* (${show.first_air_date?.substring(0, 4) || 'N/A'})\n`;
									showList += `⭐ Rating: ${show.vote_average.toFixed(1)}/10\n`;
									showList += `📝 Plot: ${show.overview}\n\n`;
								});

								showList += "Please reply with the number of the show you want.";
								await sock.sendMessage(chatId, { text: showList });
							} else {
								response = `😕 Could not find a TV show with the name "${showName}".`;
							}
						} catch (e) {
							logger.error({ err: e }, "Failed to fetch TV show from TMDB");
							response = "❌ An error occurred while fetching TV show information.";
						}
					}
				}
				break;

			default:
				response = `❓ Unknown command: ${cmd}\n\nType .help for available commands.`;
		}

		if (response) {
			await sock.sendMessage(chatId, { text: response });
			logger.info(`Command executed: ${cmd} -> ${response.substring(0, 50)}...`);
		}

	} catch (e) {
		logger.error({ err: e }, "Failed to handle command");
		if (sock && msg.key?.remoteJid) {
			await sock.sendMessage(msg.key.remoteJid, {
				text: `❌ Command failed: ${e.message}`
			});
		}
	}
}

async function generateBirthdayMessage(birthday) {
	if (!genAI) {
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;

		const getOrdinalSuffix = (num) => {
			const j = num % 10;
			const k = num % 100;
			if (j === 1 && k !== 11) return num + "st";
			if (j === 2 && k !== 12) return num + "nd";
			if (j === 3 && k !== 13) return num + "rd";
			return num + "th";
		};

		const ageText = getOrdinalSuffix(age);

		if (birthday.relationship === 'family') {
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'relative') {
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'friend') {
			if (birthday.gender === 'male') {
				return `Happy ${ageText} birthday brother! 🎉🎂`;
			} else {
				return `Happy ${ageText} birthday sis! 🎉🎂`;
			}
		}

		return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
	}

	try {
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;

		const getOrdinalSuffix = (num) => {
			const j = num % 10;
			const k = num % 100;
			if (j === 1 && k !== 11) return num + "st";
			if (j === 2 && k !== 12) return num + "nd";
			if (j === 3 && k !== 13) return num + "rd";
			return num + "th";
		};

		const ageText = getOrdinalSuffix(age);

		const prompt = `Generate a personalized birthday wish for someone named ${birthday.name} who is turning ${ageText} today. 
		
		Details:
		- Name: ${birthday.name}
		- Age: ${ageText}
		- Gender: ${birthday.gender}
		- Relationship: ${birthday.relationship}
		
		Rules:
		- If relationship is "friend" and gender is "male", use "brother" in the message
		- If relationship is "friend" and gender is "female", use "sis" in the message  
		- If relationship is "relative", use their actual name in the message
		- If relationship is "family", use the relationship term (like "mom", "dad", "sister", etc.) in the message
		
		Make it warm, personal, and celebratory. Include appropriate emojis. Keep it under 50 words.`;

		const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
		const result = await model.generateContent(prompt);
		const response = await result.response;
		return response.text();

	} catch (error) {
		logger.error({ err: error }, "Failed to generate birthday message with AI");
		handleGeminiError(error);
		// Fallback to non-AI message
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;

		const getOrdinalSuffix = (num) => {
			const j = num % 10;
			const k = num % 100;
			if (j === 1 && k !== 11) return num + "st";
			if (j === 2 && k !== 12) return num + "nd";
			if (j === 3 && k !== 13) return num + "rd";
			return num + "th";
		};

		const ageText = getOrdinalSuffix(age);

		if (birthday.relationship === 'family') {
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'relative') {
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'friend') {
			if (birthday.gender === 'male') {
				return `Happy ${ageText} birthday brother! 🎉🎂`;
			} else {
				return `Happy ${ageText} birthday sis! 🎉🎂`;
			}
		}

		return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
	}
}

async function checkBirthdays(io) {
	if (!sock || !connectionStatus.connected) return;
	if (!db.isSupabaseConfigured) return;

	try {
		const tomorrow = dayjs.tz(undefined, "Asia/Colombo").add(1, 'day').format('MM-DD');
		const birthdays = await db.getBirthdaysByDate(tomorrow);
		const pendingSchedule = await db.getPendingSchedule();

		for (const birthday of birthdays) {
			const alreadySent = pendingSchedule.some(item =>
				item.recipient === birthday.phone &&
				(item.caption || '').includes('birthday') &&
				dayjs(item.send_at).isSame(dayjs().add(1, 'day'), 'day')
			);

			if (!alreadySent) {
				const messageTime = dayjs.tz(undefined, "Asia/Colombo").add(1, 'day').hour(0).minute(0).second(0);
				const birthdayMessage = birthday.custom_message || await generateBirthdayMessage(birthday);

				await db.addScheduleItems([{
					batchId: nanoid(),
					recipient: birthday.phone,
					caption: birthdayMessage,
					mediaUrl: null,
					mediaType: null,
					sendAt: messageTime.toISOString(),
				}]);

				logger.info(`Scheduled ${birthday.custom_message ? 'custom' : 'AI-generated'} birthday message for ${birthday.name} (${birthday.phone}) for tomorrow at 12:00 AM`);
			}
		}

		const allPending = await db.getPendingSchedule();
		io.emit("queue:update", { size: allPending.length });

	} catch (e) {
		logger.error({ err: e }, "Failed to check birthdays");
	}
}

async function processQueue(io) {
	if (!sock || !connectionStatus.connected) {
		logger.debug("Queue processing skipped: WhatsApp not connected");
		return;
	}
	if (sendingInProgress) {
		logger.debug("Queue processing skipped: Already in progress");
		return;
	}
	if (!db.isSupabaseConfigured) {
		logger.debug("Queue processing skipped: Database not configured");
		return;
	}

	sendingInProgress = true;
	let processedCount = 0;
	let successCount = 0;
	let failedCount = 0;

	try {
		const dueItems = await db.getDueScheduleItems();

		if (dueItems.length === 0) {
			return;
		}

		logger.info(`Processing ${dueItems.length} scheduled message(s)`);

		for (const item of dueItems) {
			processedCount++;

			try {
				// Validate WhatsApp connection before each send
				if (!sock || !connectionStatus.connected) {
					logger.warn("Lost connection during queue processing, stopping");
					break;
				}

				let jid;

				// Check if recipient is a group JID (ends with @g.us)
				if (item.recipient.includes('@g.us')) {
					jid = item.recipient;
				} else {
					// It's a phone number - convert to individual JID
					let phone = item.recipient.replace(/[^\d]/g, "");
					if (phone.startsWith('+')) {
						phone = phone.substring(1);
					}
					if (phone.length < 10) {
						await db.updateScheduleStatus(item.id, "failed", "Invalid phone number: too short");
						logger.warn({ item }, "Phone number too short");
						failedCount++;
						io.emit("queue:item", { id: item.id, status: 'failed', error: 'Invalid phone number' });
						continue;
					}
					jid = jidNormalizedUser(phone + "@s.whatsapp.net");
				}

				const hasMedia = Boolean(item.media_url);
				let localOrHttp = null;

				if (hasMedia) {
					if (/^https?:\/\//i.test(item.media_url)) {
						localOrHttp = item.media_url;
					} else {
						const rel = item.media_url.replace(/^\//, "").split("/").join(path.sep);
						localOrHttp = path.join(PUBLIC_DIR, rel);
					}
				}

				if (hasMedia) {
					const mt = (item.media_type || "").toLowerCase();
					let mediaCategory = "document";

					if (mt.includes("image")) {
						mediaCategory = "image";
					} else if (mt.includes("video")) {
						mediaCategory = "video";
					} else if (mt.includes("audio")) {
						mediaCategory = "audio";
					}

					let content;
					if (/^https?:/i.test(localOrHttp)) {
						content = { url: localOrHttp };
					} else {
						try {
							await fsp.access(localOrHttp);
							const buf = await fsp.readFile(localOrHttp);
							content = buf;
						} catch (fileError) {
							logger.error("File not found:", localOrHttp, fileError.message);
							await db.updateScheduleStatus(item.id, "failed", "Media file not found");
							failedCount++;
							io.emit("queue:item", { id: item.id, status: 'failed', error: 'Media file not found' });
							continue;
						}
					}

					const messageOptions = { caption: item.caption || undefined };

					if (mediaCategory === "image") {
						await sock.sendMessage(jid, { image: content, ...messageOptions });
					} else if (mediaCategory === "video") {
						await sock.sendMessage(jid, { video: content, ...messageOptions });
					} else if (mediaCategory === "audio") {
						await sock.sendMessage(jid, { audio: content, mimetype: item.media_type });
					} else {
						await sock.sendMessage(jid, {
							document: content,
							...messageOptions,
							mimetype: item.media_type || mime.lookup(item.media_url) || "application/octet-stream",
							fileName: path.basename(localOrHttp)
						});
					}
				} else if (item.caption) {
					await sock.sendMessage(jid, { text: item.caption });
				} else {
					// No content to send
					await db.updateScheduleStatus(item.id, "failed", "No message content");
					failedCount++;
					io.emit("queue:item", { id: item.id, status: 'failed', error: 'No message content' });
					continue;
				}

				// Message sent successfully
				await db.updateScheduleStatus(item.id, "sent", null, new Date().toISOString());
				successCount++;
				io.emit("queue:item", { id: item.id, status: 'sent' });
				logger.info(`Message sent to ${item.recipient} (${processedCount}/${dueItems.length})`);

				// Clean up local media file after successful send
				if (hasMedia && localOrHttp && !(/^https?:/i.test(localOrHttp))) {
					try {
						await fsp.unlink(localOrHttp);
						logger.info("Deleted media file after sending:", localOrHttp);
					} catch (deleteError) {
						logger.warn("Failed to delete media file:", localOrHttp, deleteError.message);
					}
				}

				// Small delay between messages to avoid rate limiting
				if (processedCount < dueItems.length) {
					await new Promise(r => setTimeout(r, 1000));
				}

			} catch (e) {
				const errorMessage = e?.message || String(e);
				logger.error({ err: e, item }, "Send failed");

				// Check if error is retryable
				const isRetryable = isRetryableError(errorMessage);

				if (isRetryable) {
					const retryResult = await db.incrementRetryCount(item.id, 3);

					if (retryResult.shouldRetry) {
						logger.info(`Message to ${item.recipient} will retry (attempt ${retryResult.retryCount}/3) at ${retryResult.nextRetryAt}`);
						io.emit("queue:item", {
							id: item.id,
							status: 'pending',
							error: `Retry ${retryResult.retryCount}/3: ${errorMessage}`,
							nextRetryAt: retryResult.nextRetryAt
						});
					} else {
						await db.updateScheduleStatus(item.id, "failed", `Max retries exceeded: ${errorMessage}`);
						failedCount++;
						io.emit("queue:item", { id: item.id, status: 'failed', error: `Max retries exceeded: ${errorMessage}` });
					}
				} else {
					// Non-retryable error
					await db.updateScheduleStatus(item.id, "failed", errorMessage);
					failedCount++;
					io.emit("queue:item", { id: item.id, status: 'failed', error: errorMessage });
				}
			}
		}

		logger.info(`Queue processing complete: ${successCount} sent, ${failedCount} failed out of ${processedCount} processed`);

		const allPending = await db.getPendingSchedule();
		io.emit("queue:update", { size: allPending.length });

	} catch (e) {
		logger.error({ err: e }, "Queue processing error");
	} finally {
		sendingInProgress = false;
	}
}

// Helper to determine if an error is retryable
function isRetryableError(errorMessage) {
	const retryablePatterns = [
		/timeout/i,
		/network/i,
		/connection/i,
		/ETIMEDOUT/i,
		/ECONNRESET/i,
		/ENOTFOUND/i,
		/socket hang up/i,
		/rate limit/i,
		/too many requests/i,
		/503/,
		/502/,
		/500/,
	];

	return retryablePatterns.some(pattern => pattern.test(errorMessage));
}
async function cleanupOldMediaFiles() {
	try {
		const files = await fsp.readdir(UPLOADS_DIR);

		if (!db.isSupabaseConfigured) {
			// Database not configured, skip cleanup
			return;
		}

		const pendingSchedule = await db.getPendingSchedule();
		const now = Date.now();
		const oneDayAgo = now - (24 * 60 * 60 * 1000);

		const activeMediaFiles = new Set(
			pendingSchedule
				.map(item => item.media_url)
				.filter(url => url && !url.startsWith('http'))
				.map(url => path.basename(url))
		);

		let deletedCount = 0;
		for (const file of files) {
			if (file === '.gitkeep') continue;

			const filePath = path.join(UPLOADS_DIR, file);
			const stats = await fsp.stat(filePath);

			if (stats.mtimeMs < oneDayAgo && !activeMediaFiles.has(file)) {
				try {
					await fsp.unlink(filePath);
					deletedCount++;
					logger.info("Cleaned up old media file:", file);
				} catch (err) {
					logger.warn("Failed to delete old file:", file, err.message);
				}
			}
		}

		if (deletedCount > 0) {
			logger.info(`Cleanup complete: deleted ${deletedCount} old media file(s)`);
		}
	} catch (err) {
		logger.error({ err }, "Media cleanup failed");
	}
}

function scheduleDailyBirthdayCheck(io) {
	const now = dayjs.tz(undefined, "Asia/Colombo");
	let nextCheck = now.hour(23).minute(55).second(0);

	if (now.isAfter(nextCheck)) {
		nextCheck = nextCheck.add(1, 'day');
	}

	const msUntilNextCheck = nextCheck.diff(now);

	logger.info(`Next daily birthday check scheduled for ${nextCheck.format()} (${Math.round(msUntilNextCheck / 1000 / 60)} minutes from now).`);

	setTimeout(() => {
		logger.info("Running scheduled daily birthday check...");
		checkBirthdays(io);
		scheduleDailyBirthdayCheck(io);
	}, msUntilNextCheck);
}

export function initBaileys(io) {
	initializeGemini();
	startBaileys(io);
	setInterval(() => processQueue(io), 10000);
	setInterval(cleanupOldMediaFiles, 24 * 60 * 60 * 1000);
	cleanupOldMediaFiles();
	checkBirthdays(io);
	scheduleDailyBirthdayCheck(io);
}

export function getSocket() {
	return sock;
}

export function getConnectionStatus() {
	return connectionStatus;
}

export function isConnectingStatus() {
	return isConnecting;
}

export function getUptime() {
	if (!startTime) return "Unknown";
	const uptime = Date.now() - startTime;
	const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
	const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
	const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
	return `${days}d ${hours}h ${minutes}m`;
}
