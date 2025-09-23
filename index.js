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

// 🔹 Crear carpeta de logs si no existe
if (!fs.existsSync("logs")) fs.mkdirSync("logs");

// 🔹 Función para escribir mensajes en los logs
function log(message, level = "INFO") {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const time = now.toISOString();
  const logMessage = `[${time}] [${level}] ${message}\n`;
  fs.appendFileSync(`logs/app-${date}.log`, logMessage);
}

// 🔹 Cargar y compilar plantillas de correo
const templateSources = {
  notification: fs.readFileSync("templates/notification.html", "utf-8"),
  budget: fs.readFileSync("templates/notification-budget.html", "utf-8"),
  albaran: fs.readFileSync("templates/notification-albaran.html", "utf-8"),
};

const templates = {
  notification: handlebars.compile(templateSources.notification),
  budget: handlebars.compile(templateSources.budget),
  albaran: handlebars.compile(templateSources.albaran),
};

// 🔹 Configuración de conexión a MySQL
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// 🔹 Configuración del transporte SMTP para envío de correos
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: process.env.MAIL_PORT,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  logger: false,
  debug: false,
});

// 🔹 Configuración del cliente IMAP para guardar correos enviados
const imapClient = new ImapFlow({
  host: process.env.IMAP_HOST,
  port: process.env.IMAP_PORT,
  secure: true,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  logger: false,
});

// 🔹 Generar mensaje raw (formato RFC822) para guardar en IMAP
async function generarRaw(message) {
  return new Promise((resolve, reject) => {
    const mail = new MailComposer(message);
    mail.compile().build((err, msg) => {
      if (err) reject(err);
      else resolve(msg);
    });
  });
}

// 🔹 Guardar el correo enviado en la carpeta "Enviados" de IMAP
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

// 🔹 Revisar y procesar nuevos registros de facturas y presupuestos
async function revisarRegistros() {
  try {
    // Consultar facturas pendientes de envío
    const [rows] = await db.query(`
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docser, qdocumento.docnum, qdocumento.docfec, qdocumento.docimptot,
             qdocumento_fichero.qdocumento_id,
             users.name, users.email, users.id
      FROM qdocumento
      JOIN users ON qdocumento.docclicod = users.usuclicod
      JOIN qdocumento_fichero ON qdocumento.doccon = qdocumento_fichero.qdocumento_id
      WHERE (qdocumento.docenviado = 0 OR qdocumento.docenviado IS NULL OR qdocumento.docenviado = '')
        AND qdocumento.doctip = 'FC'
        AND qdocumento.docfec >= '2025-09-02'
      ORDER BY qdocumento.doccon DESC 
    `);

    // Consultar presupuestos pendientes de envío
    const [rowsBudget] = await db.query(`
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docser, qdocumento.docnum, qdocumento.docfec, qdocumento.docimptot,
             qdocumento_fichero.qdocumento_id,
             users.name, users.email, users.id
      FROM qdocumento
      JOIN users ON qdocumento.docclicod = users.usuclicod
      JOIN qdocumento_fichero ON qdocumento.doccon = qdocumento_fichero.qdocumento_id
      WHERE (qdocumento.docenviado = 0 OR qdocumento.docenviado IS NULL OR qdocumento.docenviado = '')
        AND qdocumento.doctip = 'PC'
        AND qdocumento.docfec >= '2025-09-02'
      ORDER BY qdocumento.doccon DESC 
    `);

    const [rowsAlbaran] = await db.query(`
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docser, qdocumento.docnum, qdocumento.docfec, qdocumento.docimptot,
             qdocumento_fichero.qdocumento_id,
             users.name, users.email, users.id
      FROM qdocumento
      JOIN users ON qdocumento.docclicod = users.usuclicod
      JOIN qdocumento_fichero ON qdocumento.doccon = qdocumento_fichero.qdocumento_id
      WHERE (qdocumento.docenviado = 0 OR qdocumento.docenviado IS NULL OR qdocumento.docenviado = '')
        AND qdocumento.doctip = 'AC'
        AND qdocumento.docfec >= '2025-09-02'
      ORDER BY qdocumento.doccon DESC 
    `);

    if (
      (!rowsBudget && !rows && !rowsAlbaran) ||
      (rowsBudget.length === 0 && rows.length === 0 && rowsAlbaran.length === 0)
    ) {
      log("No hay registros nuevos para procesar.");
      return;
    }

    // Procesar facturas
    for (const row of rows) {
      const fecha = new Date(row.docfec);
      const fechaFormateada = new Intl.DateTimeFormat("es-ES", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(fecha);

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const link = `https://gabinetetic.com/documentos/Facturas?token=${token}`;

      await db.query(
        `INSERT INTO access_tokens (user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`,
        [row.id, token, expiresAt]
      );

      log(`Token generado para usuario ${row.name}: ${token}`);

      // Marcar como enviado antes de enviar el correo
      await db.query("UPDATE qdocumento SET docenviado = 1 WHERE doccon = ?", [
        row.doccon,
      ]);

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

      // Obtener emails agendados para este cliente
      const [agendadosRows] = await db.query(
        `SELECT ageema FROM qanet_clienteagenda WHERE ageclicod = ? AND agefuncion IN ('4','60')`,
        [row.docclicod]
      );

      // Limpiar emails nulos o vacíos
      const agendadosEmails = agendadosRows
        .map((r) => r.ageema && r.ageema.trim())
        .filter((e) => e && e.length > 0);

      // Enviar correo
      const recipients =
        agendadosEmails && agendadosEmails.length > 0
          ? agendadosEmails.join(", ")
          : row.email;

      const message = {
        from: `"Redes y Componentes" <${process.env.MAIL_USER}>`,
        to: recipients,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);

      log(
        `Correo enviado a ${row.name} (Doccon: ${row.doccon}) y a los correos [${recipients}]  | MessageId: ${info.messageId}`
      );

      // Guardar el correo en la carpeta "Enviados" si fue enviado correctamente
      if (info.messageId) {
        const rawMessage = await generarRaw(message);
        await guardarEnEnviados(rawMessage);
      }
    }

    // Procesar presupuestos
    for (const row of rowsBudget) {
      const fecha = new Date(row.docfec);
      const fechaFormateada = new Intl.DateTimeFormat("es-ES", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(fecha);

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const link = `https://gabinetetic.com/documentos/Presupuestos?token=${token}`;

      await db.query(
        `INSERT INTO access_tokens (user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`,
        [row.id, token, expiresAt]
      );

      log(`Token generado para usuario ${row.name}: ${token}`);

      // Obtener emails agendados para este cliente
      const [agendadosRows] = await db.query(
        `SELECT ageema FROM qanet_clienteagenda WHERE ageclicod = ? AND agefuncion IN ('1','60')`,
        [row.docclicod]
      );

      // Limpiar emails nulos o vacíos
      const agendadosEmails = agendadosRows
        .map((r) => r.ageema && r.ageema.trim())
        .filter((e) => e && e.length > 0);

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

      // Marcar como enviado antes de enviar el correo
      await db.query("UPDATE qdocumento SET docenviado = 1 WHERE doccon = ?", [
        row.doccon,
      ]);

      // Enviar correo
      const recipients =
        agendadosEmails && agendadosEmails.length > 0
          ? agendadosEmails.join(", ")
          : row.email;

      const message = {
        from: `"Redes y Componentes" <${process.env.MAIL_USER}>`,
        to: recipients,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);

      log(
        `Correo enviado a ${row.name} (Doccon: ${row.doccon}) y a los correos [${recipients}]  | MessageId: ${info.messageId}`
      );

      // Guardar el correo en la carpeta "Enviados" si fue enviado correctamente
      if (info.messageId) {
        const rawMessage = await generarRaw(message);
        await guardarEnEnviados(rawMessage);
      }
    }

    // Procesar albaranes
    for (const row of rowsAlbaran) {
      const fecha = new Date(row.docfec);
      const fechaFormateada = new Intl.DateTimeFormat("es-ES", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      }).format(fecha);

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const link = `https://gabinetetic.com/documentos/Albaranes?token=${token}`;

      await db.query(
        `INSERT INTO access_tokens (user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())`,
        [row.id, token, expiresAt]
      );

      log(`Token generado para usuario ${row.name}: ${token}`);

      // Obtener emails agendados para este cliente
      const [agendadosRows] = await db.query(
        `SELECT ageema FROM qanet_clienteagenda WHERE ageclicod = ? AND agefuncion IN ('1','60')`,
        [row.docclicod]
      );

      // Limpiar emails nulos o vacíos
      const agendadosEmails = agendadosRows
        .map((r) => r.ageema && r.ageema.trim())
        .filter((e) => e && e.length > 0);

      const html = templates.albaran({
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

      // Marcar como enviado antes de enviar el correo
      await db.query("UPDATE qdocumento SET docenviado = 1 WHERE doccon = ?", [
        row.doccon,
      ]);

      // Enviar correo
      const recipients =
        agendadosEmails && agendadosEmails.length > 0
          ? agendadosEmails.join(", ")
          : row.email;

      const message = {
        from: `"Redes y Componentes" <${process.env.MAIL_USER}>`,
        to: recipients,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);

      log(
        `Correo enviado a ${row.name} (Doccon: ${row.doccon}) y a los correos [${recipients}]  | MessageId: ${info.messageId}`
      );

      // Guardar el correo en la carpeta "Enviados" si fue enviado correctamente
      if (info.messageId) {
        const rawMessage = await generarRaw(message);
        await guardarEnEnviados(rawMessage);
      }
    }
  } catch (err) {
    log(`Error revisando registros: ${err.message}`, "ERROR");
  }
}

// 🔹 Ejecutar la revisión de registros cada minuto usando cron
cron.schedule("* * * * *", async () => {
  console.log("⏳ Iniciando revisión de registros...");
  await revisarRegistros();
  console.log("✅ Proceso de revisión finalizado");
});
