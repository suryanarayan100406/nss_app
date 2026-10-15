import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'models.dart';

class SessionStore {
  SessionStore(this.storage);
  final FlutterSecureStorage storage;

  static const accessKey = 'nss.mobile.access';
  static const refreshKey = 'nss.mobile.refresh';

  Future<void> saveTokens({
    required String accessToken,
    required String refreshToken,
  }) async {
    await storage.write(key: accessKey, value: accessToken);
    await storage.write(key: refreshKey, value: refreshToken);
  }

  Future<String?> get accessToken => storage.read(key: accessKey);
  Future<String?> get refreshToken => storage.read(key: refreshKey);
  Future<void> clear() async {
    await Future.wait([
      storage.delete(key: accessKey),
      storage.delete(key: refreshKey),
    ]);
  }
}

class AuthState {
  const AuthState({this.user, this.bootstrapped = false});
  final AppUser? user;
  final bool bootstrapped;
  bool get signedIn => user != null;
}
