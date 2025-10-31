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

// 🔹 Función para crear cliente IMAP (nueva instancia cada vez)
function createImapClient() {
  return new ImapFlow({
    host: process.env.IMAP_HOST,
    port: process.env.IMAP_PORT,
    secure: true,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
    logger: false,
  });
}

// 🔹 Función auxiliar para procesar guardado con retraso y manejo de errores
async function procesarGuardadoEnviados(message, messageId) {
  if (messageId) {
    log(
      `💾 Iniciando proceso de guardado en Enviados para MessageId: ${messageId}`
    );
    try {
      // Pequeño retraso para evitar conflictos de timing IMAP
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const rawMessage = await generarRaw(message);
      await guardarEnEnviados(rawMessage);
      log(
        `✅ Correo guardado exitosamente en Enviados (MessageId: ${messageId})`
      );
    } catch (saveError) {
      log(
        `❌ Error específico guardando en Enviados: ${saveError.message}`,
        "ERROR"
      );
    }
  } else {
    log(`⚠️ No se guardará en Enviados - MessageId vacío o nulo`, "ERROR");
  }
}

// 🔹 Generar mensaje raw (formato RFC822) para guardar en IMAP
async function generarRaw(message) {
  return new Promise((resolve, reject) => {
    try {
      log(`Generando mensaje raw para IMAP...`);
      const mail = new MailComposer(message);
      mail.compile().build((err, msg) => {
        if (err) {
          log(`Error generando mensaje raw: ${err.message}`, "ERROR");
          reject(err);
        } else {
          log(`Mensaje raw generado exitosamente (${msg.length} bytes)`);
          resolve(msg);
        }
      });
    } catch (err) {
      log(`Error en generarRaw: ${err.message}`, "ERROR");
      reject(err);
    }
  });
}

// 🔹 Guardar el correo enviado en la carpeta "Enviados" de IMAP
async function guardarEnEnviados(raw) {
  let imapClient = null;

  try {
    log(`Intentando conectar a IMAP para guardar correo...`);

    // Crear nueva instancia IMAP completamente fresca
    imapClient = new ImapFlow({
      host: process.env.IMAP_HOST,
      port: process.env.IMAP_PORT,
      secure: true,
      auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
      },
      logger: false,
      // Agregar configuraciones para evitar reutilización
      socketTimeout: 30000,
      greetingTimeout: 16000,
      connectionTimeout: 90000,
    });

    await imapClient.connect();
    log(`Conexión IMAP establecida exitosamente`);

    // Usar directamente INBOX.Sent que ya sabemos que funciona
    const sentFolder = "INBOX.Sent";
    log(`Intentando guardar en carpeta: ${sentFolder}`);

    await imapClient.append(sentFolder, raw, ["\\Seen"], new Date());
    log(`✅ Correo guardado exitosamente en carpeta: ${sentFolder}`);
  } catch (err) {
    log(`❌ Error guardando en Enviados: ${err.message}`, "ERROR");
    log(`Stack trace: ${err.stack}`, "ERROR");
  } finally {
    // Cerrar conexión de forma segura
    if (imapClient) {
      try {
        if (imapClient.usable) {
          await imapClient.logout();
          log(`Conexión IMAP cerrada correctamente`);
        } else {
          log(`Conexión IMAP ya estaba cerrada`);
        }
      } catch (logoutErr) {
        log(`Error cerrando conexión IMAP: ${logoutErr.message}`, "ERROR");
        // Forzar cierre si hay problemas
        try {
          imapClient.close();
        } catch (closeErr) {
          log(`Error forzando cierre IMAP: ${closeErr.message}`, "ERROR");
        }
      } finally {
        // Limpiar referencia
        imapClient = null;
      }
    }
  }
} // 🔹 Revisar y procesar nuevos registros de facturas y presupuestos
async function revisarRegistros() {
  try {
    // Consultar facturas pendientes de envío
    const [rows] = await db.query(`
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docser, qdocumento.docnum, qdocumento.docfec, qdocumento.docimptot, qdocumento.docusuariocorreo,
             qdocumento_fichero.qdocumento_id,qdocumento_fichero.docfichero,
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
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docser, qdocumento.docnum, qdocumento.docfec, qdocumento.docimptot, qdocumento.docusuariocorreo,
             qdocumento_fichero.qdocumento_id, qdocumento_fichero.docfichero,
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
      SELECT qdocumento.doccon, qdocumento.docclicod, qdocumento.docenviado, qdocumento.doceje, qdocumento.docser, qdocumento.docnum, qdocumento.docfec, qdocumento.docimptot, qdocumento.docusuariocorreo,
             qdocumento_fichero.qdocumento_id, qdocumento_fichero.docfichero,
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
        docfichero: row.docfichero,
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
        cc: "josepozo@redesycomponentes.com, qanet@redesycomponentes.com",
        bcc: row.docusuariocorreo,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);

      log(
        `Correo enviado a ${row.name} (Doccon: ${row.doccon}) y a los correos [${recipients}]  | MessageId: ${info.messageId}`
      );

      // Guardar el correo en la carpeta "Enviados" si fue enviado correctamente
      await procesarGuardadoEnviados(message, info.messageId);
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
        docfichero: row.docfichero,
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
        cc: "josepozo@redesycomponentes.com, qanet@redesycomponentes.com",
        bcc: row.docusuariocorreo,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);

      log(
        `Correo enviado a ${row.name} (Doccon: ${row.doccon}) y a los correos [${recipients}]  | MessageId: ${info.messageId}`
      );

      // Guardar el correo en la carpeta "Enviados" si fue enviado correctamente
      await procesarGuardadoEnviados(message, info.messageId);
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
        `SELECT ageema FROM qanet_clienteagenda WHERE ageclicod = ? AND agefuncion IN ('3','60')`,
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
        docfichero: row.docfichero,
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
        cc: "josepozo@redesycomponentes.com, qanet@redesycomponentes.com",
        bcc: row.docusuariocorreo,
        subject: "Notificación automática",
        html,
      };

      const info = await transporter.sendMail(message);

      log(
        `Correo enviado a ${row.name} (Doccon: ${row.doccon}) y a los correos [${recipients}]  | MessageId: ${info.messageId}`
      );

      // Guardar el correo en la carpeta "Enviados" si fue enviado correctamente
      await procesarGuardadoEnviados(message, info.messageId);
    }
  } catch (err) {
    log(`Error revisando registros: ${err.message}`, "ERROR");
  }
}

// 🔹 Función de test para verificar conexión IMAP y carpetas
async function testImapConnection() {
  // Crear nueva instancia IMAP para el test
  const imapClient = createImapClient();

  try {
    log(`🔍 Iniciando test de conexión IMAP...`);
    await imapClient.connect();
    log(`✅ Conexión IMAP exitosa`);

    const folders = await imapClient.list();
    log(`📁 Carpetas disponibles:`);
    folders.forEach((folder) => {
      log(`  - ${folder.name} (${folder.flags.join(", ")})`);
    });

    await imapClient.logout();
    log(`✅ Test IMAP completado exitosamente`);
  } catch (err) {
    log(`❌ Error en test IMAP: ${err.message}`, "ERROR");
  }
}

// 🔹 Ejecutar test IMAP al inicio (comentar después de verificar)
// testImapConnection();

// 🔹 Ejecutar la revisión de registros cada minuto usando cron
cron.schedule("* * * * *", async () => {
  console.log("⏳ Iniciando revisión de registros...");
  await revisarRegistros();
  console.log("✅ Proceso de revisión finalizado");
});
