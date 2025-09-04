import mysql from "mysql2/promise";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import cron from "node-cron";
import dotenv from "dotenv";
import fs from "fs";
import handlebars from "handlebars";
import crypto from "crypto";
import { ImapFlow } from "imapflow";

dotenv.config();

// 🔹 Carpeta de logs
if (!fs.existsSync("logs")) fs.mkdirSync("logs");

// 🔹 Función para escribir logs
function log(message, level = "INFO") {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toISOString();
  const logMessage = `[${time}] [${level}] ${message}\n`;
  fs.appendFileSync(`logs/app-${date}.log`, logMessage);
}

// 🔹 Cargar plantilla
const templateSources = {
  notification: fs.readFileSync("templates/notification.html", "utf-8"),
  budget: fs.readFileSync("templates/notification-budget.html", "utf-8"),
};

const templates = {
  notification: handlebars.compile(templateSources.notification),
  budget: handlebars.compile(templateSources.budget),
};

// 🔹 Conexión a MySQL
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// 🔹 Configuración del transporte de correo (SMTP)
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  logger: false, // no imprimir logs en consola
  debug: false,
});

// 🔹 Configuración IMAP
const imapClient = new ImapFlow({
  host: process.env.IMAP_HOST,
  port: process.env.IMAP_PORT,
  secure: true,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  logger: false, // silencia logs de imapflow
});

// 🔹 Generar mensaje raw para guardar en IMAP
async function generarRaw(message) {
  return new Promise((resolve, reject) => {
    const mail = new MailComposer(message);
    mail.compile().build((err, msg) => {
      if (err) reject(err);
      else resolve(msg);
    });
  });
}

// 🔹 Guardar en "Sent"
async function guardarEnEnviados(raw) {
  await imapClient.connect();
  try {
    await imapClient.append("INBOX.Sent", raw, ["\\Seen"], new Date());
    log(`Correo guardado en carpeta Enviados`);
  } catch (err) {
    log(`Error guardando en Enviados: ${err.message}`, "ERROR");
  } finally {
    await imapClient.logout();
  }
}

// 🔹 Revisar registros nuevos
async function revisarRegistros() {
  try {
    // Facturación
    const [rows] = await db.query(`
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docser, qdocumento.docnum, qdocumento.docfec, qdocumento.docimptot,
             qdocumento_fichero.qdocumento_id,
             users.name, users.email, users.id
      FROM qdocumento
      JOIN users ON qdocumento.docclicod = users.usuclicod
      JOIN qdocumento_fichero ON qdocumento.doccon = qdocumento_fichero.qdocumento_id
      WHERE (qdocumento.docenviado = 0 OR qdocumento.docenviado IS NULL OR qdocumento.docenviado = '')
        AND qdocumento.doctip = "FC"
        AND qdocumento.docfec >= '2025-09-02'
      ORDER BY qdocumento.doccon DESC 
    `);

    // Presupuestos
    const [rowsBudget] = await db.query(`
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docser, qdocumento.docnum, qdocumento.docfec, qdocumento.docimptot,
             qdocumento_fichero.qdocumento_id,
             users.name, users.email, users.id
      FROM qdocumento
      JOIN users ON qdocumento.docclicod = users.usuclicod
      JOIN qdocumento_fichero ON qdocumento.doccon = qdocumento_fichero.qdocumento_id
      WHERE (qdocumento.docenviado = 0 OR qdocumento.docenviado IS NULL OR qdocumento.docenviado = '')
        AND qdocumento.doctip = "PC"
        AND qdocumento.docfec >= '2025-09-02'
      ORDER BY qdocumento.doccon DESC 
    `);

    if (
      (!rowsBudget && !rows) ||
      (rowsBudget.length === 0 && rows.length === 0)
    ) {
      log("No hay registros nuevos para procesar.");
      return;
    }

    // facturación
    for (const row of rows) {
      const token = crypto.randomBytes(32).toString("hex");

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.query(
        `INSERT INTO access_tokens (user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`,
        [row.id, token, expiresAt]
      );
      log(`Token generado para usuario ${row.email}: ${token}`);

      const link = `https://gabinetetic.com/documentos/Facturas?token=${token}`;

      const fecha = new Date(row.docfec);
      const fechaFormateada = new Intl.DateTimeFormat("es-ES", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(fecha);

      const html = templates.notification({
        nombre: row.name || "usuario",
        doccon: row.doccon,
        docid: row.qdocumento_id,
        doceje: row.doceje,
        docfec: fechaFormateada,
        docimptot: row.docimptot,
        docser: row.docser,
        docnum: row.docnum,
        link: link,
      });

      const message = {
        from: `"Redes y Componentes" <${process.env.MAIL_USER}>`,
        to: row.email,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);
      log(
        `Correo enviado a ${row.email} (Doccon: ${row.doccon}) | MessageId: ${info.messageId}`
      );

      if (info.messageId) {
        const rawMessage = await generarRaw(message);
        await guardarEnEnviados(rawMessage);
      }

      await db.query("UPDATE qdocumento SET docenviado = 1 WHERE doccon = ?", [
        row.doccon,
      ]);
    }

    // presupuestos
    for (const row of rowsBudget) {
      const token = crypto.randomBytes(32).toString("hex");

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.query(
        `INSERT INTO access_tokens (user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`,
        [row.id, token, expiresAt]
      );
      log(`Token generado para usuario ${row.email}: ${token}`);

      const link = `https://gabinetetic.com/documentos/Presupuestos?token=${token}`;

      const fecha = new Date(row.docfec);
      const fechaFormateada = new Intl.DateTimeFormat("es-ES", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(fecha);

      const html = templates.budget({
        nombre: row.name || "usuario",
        doccon: row.doccon,
        docid: row.qdocumento_id,
        doceje: row.doceje,
        docfec: fechaFormateada,
        docimptot: row.docimptot,
        docser: row.docser,
        docnum: row.docnum,
        link: link,
      });

      const message = {
        from: `"Redes y Componentes" <${process.env.MAIL_USER}>`,
        to: row.email,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);
      log(
        `Correo enviado a ${row.email} (Doccon: ${row.doccon}) | MessageId: ${info.messageId}`
      );

      if (info.messageId) {
        const rawMessage = await generarRaw(message);
        await guardarEnEnviados(rawMessage);
      }

      await db.query("UPDATE qdocumento SET docenviado = 1 WHERE doccon = ?", [
        row.doccon,
      ]);
    }
  } catch (err) {
    log(`Error revisando registros: ${err.message}`, "ERROR");
  }
}

// 🔹 Ejecutar cada minuto
cron.schedule("* * * * *", async () => {
  console.log("⏳ Iniciando revisión de registros...");
  await revisarRegistros();
  console.log("✅ Proceso de revisión finalizado");
});
