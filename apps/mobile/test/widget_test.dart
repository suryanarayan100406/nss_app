import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:nss_mobile/app.dart';

void main() {
  testWidgets('NSS theme renders an accessible primary action', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: nssTheme(),
        home: Scaffold(
          body: FilledButton(
            onPressed: () {},
            child: const Text('Upload photos'),
          ),
        ),
      ),
    );
    expect(find.text('Upload photos'), findsOneWidget);
    expect(find.byType(FilledButton), findsOneWidget);
  });
}
