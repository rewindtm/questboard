'use strict';

class AppError extends Error {
  constructor(message, status = 500, code = 'error', extra = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
class ValidationError extends AppError {
  constructor(message = 'Dati non validi', fields = {}) { super(message, 400, 'validation', { fields }); }
}
class AuthError extends AppError {
  constructor(message = 'Accesso richiesto') { super(message, 401, 'unauthenticated'); }
}
class ForbiddenError extends AppError {
  constructor(message = 'Operazione non consentita') { super(message, 403, 'forbidden'); }
}
class NotFoundError extends AppError {
  constructor(message = 'Risorsa non trovata') { super(message, 404, 'not_found'); }
}
/** Il record e stato modificato da qualcun altro: `current` e la versione aggiornata. */
class ConflictError extends AppError {
  constructor(current, message = 'Il task e stato modificato da qualcun altro') {
    super(message, 409, 'conflict', { current });
  }
}

module.exports = { AppError, ValidationError, AuthError, ForbiddenError, NotFoundError, ConflictError };
