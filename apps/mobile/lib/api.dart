import 'dart:async';

import 'package:dio/dio.dart';

import 'auth.dart';
import 'models.dart';

class ApiException implements Exception {
  const ApiException(this.message, {this.code, this.statusCode});
  final String message;
  final String? code;
  final int? statusCode;
  @override
  String toString() => message;
}

class ApiClient {
  ApiClient({required this.baseUrl, required this.store})
    : _dio = Dio(
        BaseOptions(
          baseUrl: baseUrl,
          connectTimeout: const Duration(seconds: 10),
          sendTimeout: const Duration(minutes: 2),
          receiveTimeout: const Duration(minutes: 2),
          headers: {'Accept': 'application/json'},
        ),
      );

  final String baseUrl;
  final SessionStore store;
  final Dio _dio;
  Future<bool>? _refreshFuture;

  Future<Response<dynamic>> _request(
    String method,
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    bool retry = true,
    ProgressCallback? onSendProgress,
    CancelToken? cancelToken,
  }) async {
    final access = await store.accessToken;
    try {
      return await _dio.request<dynamic>(
        path,
        data: data,
        queryParameters: queryParameters,
        cancelToken: cancelToken,
        onSendProgress: onSendProgress,
        options: Options(
          method: method,
          headers: access == null ? null : {'Authorization': 'Bearer $access'},
        ),
      );
    } on DioException catch (error) {
      if (error.response?.statusCode == 401 && retry) {
        final refreshed = await refresh();
        if (refreshed)
          return _request(
            method,
            path,
            data: data,
            queryParameters: queryParameters,
            retry: false,
            onSendProgress: onSendProgress,
            cancelToken: cancelToken,
          );
      }
      throw _toException(error);
    }
  }

  Future<bool> refresh() async {
    final inFlight = _refreshFuture;
    if (inFlight != null) return inFlight;

    final future = _refreshOnce();
    _refreshFuture = future;
    try {
      return await future;
    } finally {
      if (identical(_refreshFuture, future)) _refreshFuture = null;
    }
  }

  Future<bool> _refreshOnce() async {
    final refreshToken = await store.refreshToken;
    if (refreshToken == null) return false;
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/mobile/refresh',
        data: {'refreshToken': refreshToken},
      );
      await store.saveTokens(
        accessToken: response.data!['accessToken'] as String,
        refreshToken: response.data!['refreshToken'] as String,
      );
      return true;
    } catch (_) {
      await store.clear();
      return false;
    }
  }

  Future<Map<String, dynamic>> _json(
    String method,
    String path, {
    Object? data,
    Map<String, dynamic>? queryParameters,
    ProgressCallback? onSendProgress,
    CancelToken? cancelToken,
  }) async {
    final response = await _request(
      method,
      path,
      data: data,
      queryParameters: queryParameters,
      onSendProgress: onSendProgress,
      cancelToken: cancelToken,
    );
    return (response.data as Map).cast<String, dynamic>();
  }

  Future<AppUser?> me() async {
    final response = await _request('GET', '/auth/me');
    final user = (response.data as Map)['user'];
    return user is Map ? AppUser.fromJson(user.cast<String, dynamic>()) : null;
  }

  Future<AppUser> login(String email, String password) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '/auth/mobile/login',
        data: {'email': email, 'password': password},
      );
      if (response.data == null)
        throw const ApiException('Sign in returned an empty response.');
      await store.saveTokens(
        accessToken: response.data!['accessToken'] as String,
        refreshToken: response.data!['refreshToken'] as String,
      );
      return AppUser.fromJson(
        (response.data!['user'] as Map).cast<String, dynamic>(),
      );
    } on DioException catch (error) {
      throw _toException(error);
    }
  }

  Future<void> register(
    String displayName,
    String email,
    String password,
  ) async {
    await _plain('POST', '/auth/mobile/register', {
      'displayName': displayName,
      'email': email,
      'password': password,
    });
  }

  Future<void> forgotPassword(String email) async {
    await _plain('POST', '/auth/mobile/forgot-password', {'email': email});
  }

  Future<void> resetPassword(String token, String password) async {
    await _plain('POST', '/auth/mobile/reset-password', {
      'token': token,
      'password': password,
    });
  }

  Future<void> logout() async {
    final refreshToken = await store.refreshToken;
    try {
      await _request(
        'POST',
        '/auth/mobile/logout',
        data: {'refreshToken': refreshToken},
      );
    } finally {
      await store.clear();
    }
  }

  Future<List<EventRecord>> events({String? query, String? status}) async {
    final data = await _json(
      'GET',
      '/public/events',
      queryParameters: {
        'pageSize': 100,
        if (query != null && query.isNotEmpty) 'q': query,
        if (status != null) 'status': status,
      },
    );
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .map(EventRecord.fromJson)
        .toList();
  }

  Future<EventRecord> event(String slug) async {
    final data = await _json('GET', '/public/events/$slug');
    return EventRecord.fromJson((data['event'] as Map).cast<String, dynamic>());
  }

  Future<List<Contribution>> contributions() async {
    final data = await _json('GET', '/me/photos');
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .map(Contribution.fromJson)
        .toList();
  }

  Future<List<NotificationItem>> notifications() async {
    final data = await _json('GET', '/me/notifications');
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .map(NotificationItem.fromJson)
        .toList();
  }

  Future<void> markNotificationRead(String id) async {
    await _json('POST', '/me/notifications/$id/read', data: const {});
  }

  Future<List<ReviewItem>> reviewQueue() async {
    final data = await _json(
      'GET',
      '/moderation/photos',
      queryParameters: {'pageSize': 100},
    );
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .map(ReviewItem.fromJson)
        .toList();
  }

  Future<void> decide(String id, String action, {String? reason}) async {
    await _json(
      'POST',
      '/moderation/photos/$id/decision',
      data: {'action': action, if (reason != null) 'reason': reason},
    );
  }

  Future<Map<String, dynamic>> dashboard() => _json('GET', '/admin/dashboard');
  Future<List<Map<String, dynamic>>> adminEvents() async {
    final data = await _json(
      'GET',
      '/admin/events',
      queryParameters: {'pageSize': 100},
    );
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  Future<Map<String, dynamic>> createEvent(Map<String, dynamic> data) =>
      _json('POST', '/admin/events', data: data);
  Future<Map<String, dynamic>> updateEvent(
    String id,
    Map<String, dynamic> data,
  ) => _json('PATCH', '/admin/events/$id', data: data);
  Future<void> publishEvent(String id) async {
    await _json('POST', '/admin/events/$id/publish', data: const {});
  }

  Future<void> scheduleEvent(String id, DateTime runAt) async {
    await _json(
      'POST',
      '/admin/events/$id/schedule',
      data: {'runAt': runAt.toUtc().toIso8601String()},
    );
  }

  Future<void> archiveEvent(String id) async {
    await _json('POST', '/admin/events/$id/archive', data: const {});
  }

  Future<void> unpublishEvent(String id) async {
    await _json('POST', '/admin/events/$id/unpublish', data: const {});
  }

  Future<List<Map<String, dynamic>>> archives() async {
    final data = await _json('GET', '/admin/academic-years');
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  Future<Map<String, dynamic>> academicYear(String id) async {
    final data = await _json('GET', '/admin/academic-years/$id');
    return (data['item'] as Map).cast<String, dynamic>();
  }

  Future<void> publishAcademicYear(String id) async {
    await _json('POST', '/admin/academic-years/$id/publish', data: const {});
  }

  Future<void> unpublishAcademicYear(String id) async {
    await _json('POST', '/admin/academic-years/$id/unpublish', data: const {});
  }

  Future<List<Map<String, dynamic>>> adminTeam() async {
    final data = await _json('GET', '/admin/team');
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  Future<void> assignRoster(
    String academicYearId, {
    required String memberId,
    required String designation,
    int displayOrder = 0,
    bool featured = false,
  }) async {
    await _json(
      'POST',
      '/admin/academic-years/$academicYearId/roster',
      data: {
        'memberId': memberId,
        'designation': designation,
        'displayOrder': displayOrder,
        'featured': featured,
      },
    );
  }

  Future<void> updateRoster(
    String academicYearId,
    String membershipId, {
    String? designation,
    int? displayOrder,
    bool? featured,
  }) async {
    await _json(
      'PATCH',
      '/admin/academic-years/$academicYearId/roster/$membershipId',
      data: {
        if (designation != null) 'designation': designation,
        if (displayOrder != null) 'displayOrder': displayOrder,
        if (featured != null) 'featured': featured,
      },
    );
  }

  Future<void> removeRoster(String academicYearId, String membershipId) async {
    await _request(
      'DELETE',
      '/admin/academic-years/$academicYearId/roster/$membershipId',
    );
  }

  Future<List<Map<String, dynamic>>> media() async {
    final data = await _json(
      'GET',
      '/admin/media',
      queryParameters: {'pageSize': 100},
    );
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  Future<List<Map<String, dynamic>>> users() async {
    final data = await _json('GET', '/admin/users');
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  Future<List<Map<String, dynamic>>> audit() async {
    final data = await _json(
      'GET',
      '/admin/audit',
      queryParameters: {'pageSize': 100},
    );
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  Future<List<Map<String, dynamic>>> homepageRevisions() async {
    final data = await _json('GET', '/admin/content/homepage');
    return ((data['items'] as List<dynamic>? ?? const []))
        .whereType<Map<String, dynamic>>()
        .toList();
  }

  Future<Map<String, dynamic>> uploadPhoto({
    required String eventId,
    required String filePath,
    required String fileName,
    required String clientSubmissionId,
    required bool creditRequested,
    ProgressCallback? onSendProgress,
    CancelToken? cancelToken,
  }) async {
    final form = FormData.fromMap({
      'photos': await MultipartFile.fromFile(filePath, filename: fileName),
      'consent': 'true',
      'creditRequested': '$creditRequested',
      'clientSubmissionIds': '["$clientSubmissionId"]',
    });
    return _json(
      'POST',
      '/events/$eventId/photos',
      data: form,
      onSendProgress: onSendProgress,
      cancelToken: cancelToken,
    );
  }

  Future<void> _plain(String method, String path, Object data) async {
    try {
      await _dio.request<dynamic>(
        path,
        data: data,
        options: Options(method: method),
      );
    } on DioException catch (error) {
      throw _toException(error);
    }
  }

  String absoluteUrl(String path) {
    final value = Uri.parse(path);
    if (value.hasScheme) return path;
    final base = Uri.parse(baseUrl.endsWith('/') ? baseUrl : '$baseUrl/');
    return base.resolve(path).toString();
  }

  String endpointUrl(String path) {
    final cleanPath = path.startsWith('/') ? path.substring(1) : path;
    return '${baseUrl.replaceFirst(RegExp(r'/$'), '')}/$cleanPath';
  }

  ApiException _toException(DioException error) {
    final data = error.response?.data;
    if (data is Map && data['error'] is Map) {
      final detail = (data['error'] as Map).cast<String, dynamic>();
      return ApiException(
        detail['message'] as String? ?? 'The request failed.',
        code: detail['code'] as String?,
        statusCode: error.response?.statusCode,
      );
    }
    return ApiException(
      error.message ?? 'The network request failed.',
      statusCode: error.response?.statusCode,
    );
  }
}
