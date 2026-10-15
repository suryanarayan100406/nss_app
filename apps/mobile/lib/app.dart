import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:go_router/go_router.dart';

import 'api.dart';
import 'auth.dart';
import 'config.dart';
import 'models.dart';
import 'screens.dart';

final class AppController extends ChangeNotifier {
  AppController(this.api);
  final ApiClient api;
  AuthState state = const AuthState();

  Future<void> bootstrap() async {
    try {
      final user = await api.me();
      state = AuthState(user: user, bootstrapped: true);
    } catch (_) {
      state = const AuthState(bootstrapped: true);
    }
    notifyListeners();
  }

  Future<void> login(String email, String password) async {
    final user = await api.login(email, password);
    state = AuthState(user: user, bootstrapped: true);
    notifyListeners();
  }

  Future<void> register(String name, String email, String password) =>
      api.register(name, email, password);

  Future<void> logout() async {
    try {
      await api.logout();
    } catch (_) {
      // Local credentials are cleared by ApiClient even if the network is down.
    } finally {
      state = const AuthState(bootstrapped: true);
      notifyListeners();
    }
  }
}

final appControllerProvider = Provider<AppController>(
  (ref) => throw UnimplementedError(),
);

GoRouter buildRouter(AppController controller) => GoRouter(
  initialLocation: '/home',
  refreshListenable: controller,
  redirect: (context, state) {
    final signedIn = controller.state.signedIn;
    final authRoute = {
      '/login',
      '/register',
      '/forgot-password',
      '/verify-email',
      '/reset-password',
    }.contains(state.uri.path);
    if (!controller.state.bootstrapped) return '/login';
    if (!signedIn && !authRoute) return '/login';
    if (signedIn && authRoute) return '/home';
    return null;
  },
  routes: [
    GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
    GoRoute(path: '/register', builder: (_, __) => const RegisterScreen()),
    GoRoute(
      path: '/forgot-password',
      builder: (_, __) => const ForgotPasswordScreen(),
    ),
    GoRoute(
      path: '/verify-email',
      builder: (_, __) => const VerifyEmailScreen(),
    ),
    GoRoute(
      path: '/reset-password',
      builder: (_, state) =>
          ResetPasswordScreen(token: state.uri.queryParameters['token'] ?? ''),
    ),
    ShellRoute(
      builder: (_, __, child) => AppShell(child: child),
      routes: [
        GoRoute(path: '/home', builder: (_, __) => const HomeScreen()),
        GoRoute(
          path: '/events',
          builder: (_, __) => const EventsScreen(),
          routes: [
            GoRoute(
              path: ':slug',
              builder: (_, state) =>
                  EventDetailScreen(slug: state.pathParameters['slug']!),
            ),
          ],
        ),
        GoRoute(
          path: '/uploads',
          builder: (_, state) =>
              UploadQueueScreen(eventId: state.uri.queryParameters['event']),
        ),
        GoRoute(
          path: '/contributions',
          builder: (_, __) => const ContributionsScreen(),
        ),
        GoRoute(path: '/inbox', builder: (_, __) => const InboxScreen()),
        GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
        GoRoute(
          path: '/review',
          redirect: (_, __) =>
              controller.state.user?.role == UserRole.approver ||
                  controller.state.user?.role == UserRole.admin
              ? null
              : '/home',
          builder: (_, __) => const ReviewScreen(),
        ),
        GoRoute(
          path: '/review/:id',
          redirect: (_, __) =>
              controller.state.user?.role == UserRole.approver ||
                  controller.state.user?.role == UserRole.admin
              ? null
              : '/home',
          builder: (_, state) => ReviewDetailScreen(
            id: state.pathParameters['id']!,
            item: state.extra is ReviewItem ? state.extra as ReviewItem : null,
          ),
        ),
        GoRoute(
          path: '/admin',
          redirect: (_, __) =>
              controller.state.user == null ||
                  controller.state.user!.role != UserRole.admin
              ? '/home'
              : null,
          builder: (_, __) => const AdminHomeScreen(),
        ),
        GoRoute(
          path: '/admin/events/new',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, __) => const AdminEventFormScreen(),
        ),
        GoRoute(
          path: '/admin/events/:id/edit',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, state) => AdminEventFormScreen(
            eventId: state.pathParameters['id']!,
            initialEvent: state.extra is Map<String, dynamic>
                ? state.extra as Map<String, dynamic>
                : null,
          ),
        ),
        GoRoute(
          path: '/admin/events',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, __) => const AdminEventsScreen(),
        ),
        GoRoute(
          path: '/admin/archives/:id',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, state) =>
              AdminArchiveDetailScreen(id: state.pathParameters['id']!),
        ),
        GoRoute(
          path: '/admin/archives',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, __) => const AdminArchivesScreen(),
        ),
        GoRoute(
          path: '/admin/media',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, __) => const AdminListScreen(
            title: 'Media library',
            kind: AdminListKind.media,
          ),
        ),
        GoRoute(
          path: '/admin/users',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, __) => const AdminListScreen(
            title: 'Users & roles',
            kind: AdminListKind.users,
          ),
        ),
        GoRoute(
          path: '/admin/homepage',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, __) => const AdminListScreen(
            title: 'Homepage revisions',
            kind: AdminListKind.homepage,
          ),
        ),
        GoRoute(
          path: '/admin/audit',
          redirect: (_, __) =>
              controller.state.user?.role != UserRole.admin ? '/home' : null,
          builder: (_, __) => const AdminListScreen(
            title: 'Audit trail',
            kind: AdminListKind.audit,
          ),
        ),
      ],
    ),
  ],
);

ThemeData nssTheme() {
  const pine = Color(0xff132019);
  const moss = Color(0xff496b48);
  const paper = Color(0xfff5f1e4);
  const marigold = Color(0xffd79a33);
  final scheme = ColorScheme.fromSeed(
    seedColor: moss,
    brightness: Brightness.light,
    surface: paper,
    primary: moss,
    secondary: marigold,
    error: const Color(0xffa23b35),
  );
  /*
  return ThemeData(useMaterial3: true, colorScheme: scheme, scaffoldBackgroundColor: paper, fontFamily: 'sans-serif', textTheme: const TextTheme(headlineLarge: TextStyle(fontSize: 34, height: 1.05, fontWeight: FontWeight.w700, color: pine), headlineMedium: TextStyle(fontSize: 26, height: 1.1, fontWeight: FontWeight.w700, color: pine), titleLarge: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: pine), bodyLarge: TextStyle(fontSize: 16, height: 1.45, color: pine), bodyMedium: TextStyle(fontSize: 14, height: 1.4, color: Color(0xff5f6a60))), inputDecorationTheme: InputDecorationTheme(filled: true, fillColor: const Color(0xfffbf8f0), border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none), enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Color(0xffd8d4c8)),), focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: marigold, width: 2)), contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15)), cardTheme: CardThemeData(color: const Color(0xfffbf8f0), elevation: 0, margin: EdgeInsets.zero, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: const BorderSide(color: Color(0xffe0dbce))),), navigationBarTheme: const NavigationBarThemeData(backgroundColor: Color(0xfffbf8f0), indicatorColor: Color(0xffdbe6d2), labelTextStyle: WidgetStatePropertyAll(TextStyle(fontWeight: FontWeight.w700)),), elevatedButtonTheme: ElevatedButtonThemeData(style: ElevatedButton.styleFrom(minimumSize: const Size.fromHeight(50), backgroundColor: moss, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)))), filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(50), backgroundColor: moss, foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)))), outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48), foregroundColor: pine, side: const BorderSide(color: moss), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))));
  );
  );
  */
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: paper,
    fontFamily: 'sans-serif',
    textTheme: const TextTheme(
      headlineLarge: TextStyle(
        fontSize: 34,
        height: 1.05,
        fontWeight: FontWeight.w700,
        color: pine,
      ),
      headlineMedium: TextStyle(
        fontSize: 26,
        height: 1.1,
        fontWeight: FontWeight.w700,
        color: pine,
      ),
      titleLarge: TextStyle(
        fontSize: 20,
        fontWeight: FontWeight.w700,
        color: pine,
      ),
      bodyLarge: TextStyle(fontSize: 16, height: 1.45, color: pine),
      bodyMedium: TextStyle(
        fontSize: 14,
        height: 1.4,
        color: Color(0xff5f6a60),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: const Color(0xfffbf8f0),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: Color(0xffd8d4c8)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: marigold, width: 2),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 15),
    ),
    cardTheme: CardThemeData(
      color: const Color(0xfffbf8f0),
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: Color(0xffe0dbce)),
      ),
    ),
    navigationBarTheme: const NavigationBarThemeData(
      backgroundColor: Color(0xfffbf8f0),
      indicatorColor: Color(0xffdbe6d2),
      labelTextStyle: WidgetStatePropertyAll(
        TextStyle(fontWeight: FontWeight.w700),
      ),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        backgroundColor: moss,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        backgroundColor: moss,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(48),
        foregroundColor: pine,
        side: const BorderSide(color: moss),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
  );
}

class NssApp extends StatelessWidget {
  const NssApp({super.key, required this.controller});
  final AppController controller;
  @override
  Widget build(BuildContext context) => ProviderScope(
    overrides: [appControllerProvider.overrideWithValue(controller)],
    child: MaterialApp.router(
      title: 'NSS IIIT Naya Raipur',
      theme: nssTheme(),
      routerConfig: buildRouter(controller),
      debugShowCheckedModeBanner: false,
    ),
  );
}

ApiClient createApi() =>
    ApiClient(baseUrl: apiBaseUrl, store: SessionStore(FlutterSecureStorage()));
