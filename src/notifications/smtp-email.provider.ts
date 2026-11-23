import { Logger } from '@nestjs/common';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import type { EmailMessage, EmailProvider } from './notifications.service';

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from: string;
}

function extractEmail(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return match ? match[1].trim() : address.trim();
}

/**
 * Production-capable SMTP email provider using standard Node.js socket transports.
 * Supports direct TLS, STARTTLS, and AUTH LOGIN.
 */
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);

  constructor(private readonly config: SmtpConfig) {}

  async send(message: EmailMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeoutMs = 15000;
      let settled = false;
      let socket: net.Socket;
      let currentSocket: net.Socket;
      const secure = this.config.secure ?? this.config.port === 465;

      const finishError = (err: Error) => {
        if (settled) return;
        settled = true;
        try {
          currentSocket?.destroy();
        } catch {
          // ignore cleanup errors
        }
        reject(err);
      };

      const finishSuccess = () => {
        if (settled) return;
        settled = true;
        try {
          currentSocket?.end();
        } catch {
          // ignore cleanup errors
        }
        resolve();
      };

      try {
        if (secure) {
          socket = tls.connect({
            host: this.config.host,
            port: this.config.port,
            servername: this.config.host,
            rejectUnauthorized: true,
          });
        } else {
          socket = net.createConnection({
            host: this.config.host,
            port: this.config.port,
          });
        }
      } catch (err) {
        return reject(err as Error);
      }

      currentSocket = socket;
      currentSocket.setTimeout(timeoutMs);
      currentSocket.on('timeout', () => {
        finishError(new Error(`SMTP connection timed out after ${timeoutMs}ms`));
      });
      currentSocket.on('error', (err) => {
        finishError(err);
      });

      let buffer = '';
      let step = 0;
      let capabilities = '';
      let accumulatedLines: string[] = [];

      const sendLine = (line: string) => {
        currentSocket.write(line + '\r\n');
      };

      const handleResponse = (code: number, lines: string[]) => {
        const fullResponse = lines.join(' ');

        switch (step) {
          case 0: {
            // Initial 220 banner
            if (code !== 220) {
              return finishError(
                new Error(`SMTP server banner error: ${code} ${fullResponse}`),
              );
            }
            step = 1;
            sendLine('EHLO localhost');
            break;
          }
          case 1: {
            // Response to EHLO
            if (code !== 250) {
              return finishError(
                new Error(`SMTP EHLO failed: ${code} ${fullResponse}`),
              );
            }
            capabilities = fullResponse.toUpperCase();

            if (!secure && capabilities.includes('STARTTLS')) {
              step = 2;
              sendLine('STARTTLS');
            } else if (this.config.user && this.config.password) {
              step = 4;
              sendLine('AUTH LOGIN');
            } else {
              step = 7;
              sendLine(`MAIL FROM:<${extractEmail(this.config.from)}>`);
            }
            break;
          }
          case 2: {
            // Response to STARTTLS
            if (code !== 220) {
              return finishError(
                new Error(`SMTP STARTTLS failed: ${code} ${fullResponse}`),
              );
            }
            const tlsSocket = tls.connect({
              socket: currentSocket,
              host: this.config.host,
              servername: this.config.host,
              rejectUnauthorized: true,
            });
            tlsSocket.setTimeout(timeoutMs);
            tlsSocket.on('timeout', () => {
              finishError(
                new Error(`SMTP TLS connection timed out after ${timeoutMs}ms`),
              );
            });
            tlsSocket.on('error', finishError);
            currentSocket = tlsSocket;
            attachDataListener(currentSocket);
            step = 3;
            sendLine('EHLO localhost');
            break;
          }
          case 3: {
            // Response to EHLO after STARTTLS
            if (code !== 250) {
              return finishError(
                new Error(
                  `SMTP EHLO after TLS failed: ${code} ${fullResponse}`,
                ),
              );
            }
            if (this.config.user && this.config.password) {
              step = 4;
              sendLine('AUTH LOGIN');
            } else {
              step = 7;
              sendLine(`MAIL FROM:<${extractEmail(this.config.from)}>`);
            }
            break;
          }
          case 4: {
            // Response to AUTH LOGIN (expects 334)
            if (code !== 334) {
              return finishError(
                new Error(
                  `SMTP AUTH LOGIN initiation failed: ${code} ${fullResponse}`,
                ),
              );
            }
            step = 5;
            sendLine(Buffer.from(this.config.user!).toString('base64'));
            break;
          }
          case 5: {
            // Response to username (expects 334)
            if (code !== 334) {
              return finishError(
                new Error(
                  `SMTP AUTH username rejected: ${code} ${fullResponse}`,
                ),
              );
            }
            step = 6;
            sendLine(Buffer.from(this.config.password!).toString('base64'));
            break;
          }
          case 6: {
            // Response to password (expects 235)
            if (code !== 235) {
              return finishError(
                new Error(
                  `SMTP authentication failed: ${code} ${fullResponse}`,
                ),
              );
            }
            step = 7;
            sendLine(`MAIL FROM:<${extractEmail(this.config.from)}>`);
            break;
          }
          case 7: {
            // Response to MAIL FROM
            if (code !== 250) {
              return finishError(
                new Error(`SMTP MAIL FROM rejected: ${code} ${fullResponse}`),
              );
            }
            step = 8;
            sendLine(`RCPT TO:<${extractEmail(message.to)}>`);
            break;
          }
          case 8: {
            // Response to RCPT TO
            if (code !== 250) {
              return finishError(
                new Error(
                  `SMTP RCPT TO rejected for ${message.to}: ${code} ${fullResponse}`,
                ),
              );
            }
            step = 9;
            sendLine('DATA');
            break;
          }
          case 9: {
            // Response to DATA (expects 354)
            if (code !== 354) {
              return finishError(
                new Error(`SMTP DATA rejected: ${code} ${fullResponse}`),
              );
            }
            step = 10;
            const dateStr = new Date().toUTCString();
            const messageId = `<${randomUUID()}@${this.config.host}>`;
            const escapedBody = message.text
              .split(/\r?\n/)
              .map((line) => (line.startsWith('.') ? '.' + line : line))
              .join('\r\n');

            const headers = [
              `From: ${this.config.from}`,
              `To: ${message.to}`,
              `Subject: ${message.subject}`,
              `Date: ${dateStr}`,
              `Message-ID: ${messageId}`,
              'MIME-Version: 1.0',
              'Content-Type: text/plain; charset=utf-8',
              'Content-Transfer-Encoding: 8bit',
            ];

            const emailData = headers.join('\r\n') + '\r\n\r\n' + escapedBody + '\r\n.';
            sendLine(emailData);
            break;
          }
          case 10: {
            // Response to email body (expects 250)
            if (code !== 250) {
              return finishError(
                new Error(
                  `SMTP message sending failed: ${code} ${fullResponse}`,
                ),
              );
            }
            step = 11;
            try {
              sendLine('QUIT');
            } catch {
              // ignore
            }
            finishSuccess();
            break;
          }
          default:
            break;
        }
      };

      const attachDataListener = (s: net.Socket) => {
        s.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          while (buffer.includes('\r\n')) {
            const idx = buffer.indexOf('\r\n');
            const rawLine = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const match = rawLine.match(/^(\d{3})([ -])(.*)$/);
            if (match) {
              const [, codeStr, sep, text] = match;
              const code = parseInt(codeStr, 10);
              accumulatedLines.push(text);

              if (sep === ' ') {
                const lines = accumulatedLines;
                accumulatedLines = [];
                handleResponse(code, lines);
              }
            }
          }
        });
      };

      attachDataListener(currentSocket);
    });
  }
}
